/**
 * Claude Tool — Invoke Claude Code from within pi
 *
 * Registers a `claude` tool that delegates tasks to Claude Code via the
 * @anthropic-ai/claude-agent-sdk. Claude Code has web search, file access,
 * bash, code editing, and all built-in tools. Results stream back live.
 *
 * ## Streaming Overlay
 *
 * In interactive mode (ctx.hasUI), a non-capturing overlay panel streams
 * Claude Code's output in real-time on the right side of the terminal.
 * The overlay is passive — it doesn't steal keyboard focus, so the agent
 * and user can continue working. It auto-closes when the tool finishes.
 *
 * In headless mode (subagents), the overlay is skipped entirely.
 * The tool behavior is identical regardless of UI availability.
 *
 * ## Session Persistence
 *
 * Every invocation creates a persistent Claude Code session stored at:
 *   ~/.claude/projects/<encoded-cwd>/<session-id>.jsonl
 *
 * Sessions are indexed locally in .pi/claude-sessions.json (last 50) with
 * prompt, model, timestamp, cost, and turns for quick lookup.
 *
 * To resume a session, pass `resumeSessionId` with the session UUID.
 * This loads the conversation history and continues where it left off.
 * Useful for retrying cancelled runs or asking follow-up questions.
 *
 * From the CLI: `claude --resume <session-id>`
 *
 * The session ID is shown in the tool's live progress and final output,
 * and also available in the tool result details for other agents to use.
 *
 * ## Concurrency
 *
 * Multiple claude tool calls can run in parallel. Each invocation has its
 * own isolated state (text buffer, tool tracking, abort controller).
 * No shared mutable state between calls. Only one overlay is shown at a
 * time — concurrent calls skip the overlay for the second+ invocations.
 */

import type { ExtensionAPI, Theme } from "@mariozechner/pi-coding-agent";
import { truncateHead, DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Text, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@mariozechner/pi-tui";
import type { TUI, Component } from "@mariozechner/pi-tui";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";

// ── Helpers ──

function formatDuration(ms: number): string {
	const secs = Math.floor(ms / 1000);
	if (secs < 60) return `${secs}s`;
	const mins = Math.floor(secs / 60);
	const rem = secs % 60;
	return `${mins}m${rem.toString().padStart(2, "0")}s`;
}

function countTokensApprox(text: string): number {
	return Math.ceil(text.length / 4);
}

/** Compress ["WebFetch","WebFetch","WebFetch","Read","Read"] → "WebFetch×3 → Read×2" */
function compressToolChain(tools: string[]): string {
	if (tools.length === 0) return "";
	const groups: { name: string; count: number }[] = [];
	for (const tool of tools) {
		const last = groups[groups.length - 1];
		if (last && last.name === tool) {
			last.count++;
		} else {
			groups.push({ name: tool, count: 1 });
		}
	}
	return groups
		.map((g) => (g.count > 1 ? `${g.name}×${g.count}` : g.name))
		.join(" → ");
}

/** Append a session record to ~/.pi/history/<project>/claude-sessions.json */
function indexSession(cwd: string, record: {
	sessionId: string;
	prompt: string;
	model?: string;
	timestamp: string;
	elapsed: number;
	cost: number;
	turns: number;
}) {
	try {
		const project = basename(cwd);
		const dir = join(homedir(), ".pi", "history", project);
		mkdirSync(dir, { recursive: true });
		const file = join(dir, "claude-sessions.json");
		let sessions: any[] = [];
		try {
			sessions = JSON.parse(readFileSync(file, "utf-8"));
		} catch {}
		sessions.push(record);
		if (sessions.length > 50) sessions = sessions.slice(-50);
		writeFileSync(file, JSON.stringify(sessions, null, 2) + "\n");
	} catch {}
}

// ── Overlay State & Component ──

/** Shared mutable state between streaming loop and overlay component */
interface OverlayState {
	text: string;
	phase: "thinking" | "tools" | "responding";
	toolUses: string[];
	cost: number;
	startTime: number;
	sessionId: string;
	sessionModel: string;
	responseTokens: number;
	prompt: string;
}

/** Maximum lines of streaming output to show in the overlay */
const OVERLAY_MAX_LINES = 40;

/**
 * Non-capturing overlay panel that streams Claude Code output.
 * State is mutated externally by the streaming loop; the component
 * reads it on each render() call. No caching since content changes
 * on every update.
 */
class ClaudeStreamPanel implements Component {
	constructor(
		private state: OverlayState,
		private theme: Theme,
	) {}

	render(width: number): string[] {
		const th = this.theme;
		const innerW = width - 4; // 2 for border chars, 2 for padding
		if (innerW < 10) return [];

		const lines: string[] = [];

		const pad = (content: string) => {
			const vis = visibleWidth(content);
			const padding = Math.max(0, innerW - vis);
			return th.fg("border", "│") + " " + content + " ".repeat(padding) + " " + th.fg("border", "│");
		};

		// ── Top border with title ──
		const elapsed = formatDuration(Date.now() - this.state.startTime);
		const title = ` Claude Code ${elapsed} `;
		const titleStyled = th.fg("accent", title);
		const borderRemaining = Math.max(0, innerW - title.length);
		const leftBorder = Math.floor(borderRemaining / 2);
		const rightBorder = borderRemaining - leftBorder;
		lines.push(
			th.fg("border", "╭" + "─".repeat(leftBorder)) +
			titleStyled +
			th.fg("border", "─".repeat(rightBorder) + "╮")
		);

		// ── Status line ──
		let status = "";
		const phase = this.state.phase;
		if (phase === "thinking") {
			status += th.fg("warning", "● ") + th.fg("muted", "thinking…");
		} else if (phase === "tools") {
			status += th.fg("warning", "● ") + th.fg("muted", "working…");
		} else {
			status += th.fg("success", "● ") + th.fg("muted", "responding");
			if (this.state.responseTokens > 0) {
				status += th.fg("dim", ` ~${this.state.responseTokens} tokens`);
			}
		}
		if (this.state.cost > 0) {
			status += th.fg("dim", ` · $${this.state.cost.toFixed(4)}`);
		}
		lines.push(pad(status));

		// ── Tool chain ──
		if (this.state.toolUses.length > 0) {
			const chain = compressToolChain(this.state.toolUses);
			const wrapped = wrapTextWithAnsi(th.fg("dim", "tools: " + chain), innerW);
			for (const wl of wrapped.split("\n")) {
				lines.push(pad(wl));
			}
		}

		// ── Separator ──
		lines.push(th.fg("border", "├" + "─".repeat(innerW + 2) + "┤"));

		// ── Streaming content (last N lines) ──
		const text = this.state.text;
		if (!text) {
			lines.push(pad(th.fg("dim", "Waiting for output…")));
		} else {
			// Wrap and take last N lines for auto-scrolling effect
			const rawLines = text.split("\n");
			const wrappedLines: string[] = [];
			for (const rl of rawLines) {
				if (rl === "") {
					wrappedLines.push("");
				} else {
					const wrapped = wrapTextWithAnsi(rl, innerW);
					wrappedLines.push(...wrapped.split("\n"));
				}
			}

			const display = wrappedLines.slice(-OVERLAY_MAX_LINES);
			for (const dl of display) {
				lines.push(pad(truncateToWidth(dl, innerW)));
			}
		}

		// ── Bottom border ──
		lines.push(th.fg("border", "╰" + "─".repeat(innerW + 2) + "╯"));

		return lines;
	}

	invalidate(): void {
		// No cache to clear — we always render fresh from state
	}
}

// ── Concurrency guard: only one overlay at a time ──
let overlayActive = false;

// ── Extension ──

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "claude",
		label: "Claude Code",
		description:
			`Invoke Claude Code for multi-step investigative tasks: web research, deep code analysis across many files, ` +
			`broad exploration, or anything requiring multiple tool calls and reasoning. Claude Code has web search, ` +
			`file access, bash, and all built-in tools. Do NOT use this for simple tasks you can do directly — ` +
			`curl, read a file, run a command, check git status, etc. Use your own tools for those. ` +
			`This tool spins up a full Claude Code session which is expensive and slow. Reserve it for tasks ` +
			`that genuinely benefit from autonomous multi-turn execution. ` +
			`Output is truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}. ` +
			`Set outputFile to write the result to a file instead of returning inline — saves tokens in your context. ` +
			`Set resumeSessionId to continue a previous session (e.g. after cancellation or for follow-up questions).`,

		parameters: Type.Object({
			prompt: Type.String({ description: "The task or question for Claude Code" }),
			model: Type.Optional(
				Type.String({
					description: 'Model to use (default: "sonnet"). Examples: "sonnet", "opus", "haiku"',
				})
			),
			maxTurns: Type.Optional(
				Type.Number({
					description: "Maximum number of agentic turns (default: 30)",
				})
			),
			systemPrompt: Type.Optional(
				Type.String({
					description: "Additional system prompt instructions to append",
				})
			),
			outputFile: Type.Optional(
				Type.String({
					description:
						"Write result to this file instead of returning inline. " +
						"Saves tokens in your context. Use when the result is large or " +
						"will be consumed by a subagent later (e.g. '.pi/research.md').",
				})
			),
			resumeSessionId: Type.Optional(
				Type.String({
					description:
						"Resume a previous Claude Code session by its ID. " +
						"Loads the conversation history and continues where it left off. " +
						"The session ID is returned in details of every claude tool call. " +
						"Use this to retry cancelled runs or ask follow-up questions.",
				})
			),
		}),

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const { prompt, model, maxTurns, systemPrompt, outputFile, resumeSessionId } = params;
			const startTime = Date.now();

			const abortController = new AbortController();
			if (signal) {
				signal.addEventListener("abort", () => abortController.abort());
			}

			const options: Record<string, any> = {
				abortController,
				cwd: ctx.cwd,
				maxTurns: maxTurns ?? 30,
				permissionMode: "bypassPermissions",
				persistSession: true,
				includePartialMessages: true,
			};

			if (model) options.model = model;
			if (systemPrompt) options.appendSystemPrompt = systemPrompt;
			if (resumeSessionId) options.resume = resumeSessionId;

			let fullText = "";
			let cost = 0;
			let turns = 0;
			let sessionId = "";
			let sessionModel = "";
			let toolUses: string[] = [];
			let phase: "thinking" | "tools" | "responding" = "thinking";
			let responseText = "";

			// ── Overlay setup (interactive mode only, one at a time) ──
			const showOverlay = ctx.hasUI && !overlayActive;
			let overlayTui: TUI | null = null;
			let overlayCloseFn: (() => void) | null = null;
			let overlayPromise: Promise<void> | null = null;

			const overlayState: OverlayState = {
				text: "",
				phase: "thinking",
				toolUses: [],
				cost: 0,
				startTime,
				sessionId: "",
				sessionModel: "",
				responseTokens: 0,
				prompt: prompt.length > 80 ? prompt.slice(0, 80) + "…" : prompt,
			};

			if (showOverlay) {
				overlayActive = true;
				overlayPromise = ctx.ui.custom<void>(
					(tui, theme, _kb, done) => {
						overlayTui = tui;
						overlayCloseFn = () => done();
						return new ClaudeStreamPanel(overlayState, theme);
					},
					{
						overlay: true,
						overlayOptions: {
							nonCapturing: true,
							anchor: "right-center",
							width: "50%",
							minWidth: 40,
							maxHeight: "90%",
							margin: { right: 1, top: 1, bottom: 1 },
							visible: (termWidth) => termWidth >= 100,
						},
					},
				);
			}

			/** Sync overlay state from local vars and trigger re-render */
			function updateOverlay() {
				if (!showOverlay) return;
				overlayState.text = fullText;
				overlayState.phase = phase;
				overlayState.toolUses = [...toolUses];
				overlayState.cost = cost;
				overlayState.sessionId = sessionId;
				overlayState.sessionModel = sessionModel;
				overlayState.responseTokens = countTokensApprox(responseText);
				overlayTui?.requestRender();
			}

			function emitUpdate() {
				onUpdate?.({
					content: [{ type: "text", text: fullText }],
					details: {
						streaming: true,
						startTime,
						responseTokens: countTokensApprox(responseText),
						phase,
						toolUses: [...toolUses],
						cost,
						sessionId,
						sessionModel,
					},
				});
				updateOverlay();
			}

			emitUpdate();

			try {
				const conversation = query({ prompt, options });

				for await (const message of conversation) {
					if (signal?.aborted) break;

					if (message.type === "system" && (message as any).subtype === "init") {
						sessionId = (message as any).session_id ?? "";
						sessionModel = (message as any).model ?? "";
						emitUpdate();
						continue;
					}

					if (message.type === "stream_event") {
						const delta = (message as any).event?.delta;
						if (delta?.type === "text_delta" && delta.text) {
							fullText += delta.text;
							responseText += delta.text;
							if (phase !== "responding") {
								phase = "responding";
							}
							emitUpdate();
						}
						continue;
					}

					if (message.type === "assistant") {
						for (const block of (message as any).message?.content ?? []) {
							if (block.type === "tool_use") {
								toolUses.push(block.name);
								phase = "tools";
								responseText = "";
								emitUpdate();
							}
						}
					}

					if (message.type === "result") {
						cost = (message as any).total_cost_usd ?? 0;
						turns = (message as any).num_turns ?? 0;
						if (!sessionId) sessionId = (message as any).session_id ?? "";
						if (!fullText && (message as any).result) {
							fullText = (message as any).result;
						}
					}
				}
			} catch (err: any) {
				// Close overlay before returning
				if (showOverlay) {
					overlayCloseFn?.();
					if (overlayPromise) await overlayPromise;
					overlayActive = false;
				}

				if (err.name === "AbortError" || signal?.aborted) {
					return {
						content: [{ type: "text", text: fullText || "(cancelled)" }],
						details: { cancelled: true, cost, elapsed: Date.now() - startTime, sessionId },
					};
				}
				return {
					content: [{ type: "text", text: `Error: ${err.message}` }],
					details: { error: err.message },
					isError: true,
				};
			}

			// ── Close overlay ──
			if (showOverlay) {
				overlayCloseFn?.();
				if (overlayPromise) await overlayPromise;
				overlayActive = false;
			}

			const elapsed = Date.now() - startTime;

			// Index the session for later lookup
			if (sessionId) {
				indexSession(ctx.cwd, {
					sessionId,
					prompt: prompt.slice(0, 200),
					model: sessionModel || model,
					timestamp: new Date().toISOString(),
					elapsed,
					cost,
					turns,
				});
			}

			if (!fullText.trim()) {
				return {
					content: [{ type: "text", text: "(no response from Claude Code)" }],
					details: { cost, turns, elapsed, sessionId },
				};
			}

			const totalTokens = countTokensApprox(fullText);

			// Write to file instead of returning inline
			if (outputFile) {
				try {
					const outPath = outputFile.startsWith("/")
						? outputFile
						: join(ctx.cwd, outputFile);
					const outDir = join(outPath, "..");
					mkdirSync(outDir, { recursive: true });
					writeFileSync(outPath, fullText);

					const summary =
						`Result written to ${outputFile} (~${totalTokens} tokens, ${formatSize(Buffer.byteLength(fullText))}).\n` +
						`Session: ${sessionId}`;

					return {
						content: [{ type: "text", text: summary }],
						details: {
							cost,
							turns,
							sessionId,
							sessionModel,
							elapsed,
							tokens: totalTokens,
							toolUses,
							outputFile,
						},
					};
				} catch (err: any) {
					// Fall through to inline return if write fails
				}
			}

			const truncation = truncateHead(fullText, {
				maxLines: DEFAULT_MAX_LINES,
				maxBytes: DEFAULT_MAX_BYTES,
			});

			let resultText = truncation.content;
			if (truncation.truncated) {
				resultText += `\n\n[Output truncated: ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)})]`;
			}

			return {
				content: [{ type: "text", text: resultText }],
				details: {
					cost,
					turns,
					sessionId,
					sessionModel,
					elapsed,
					tokens: totalTokens,
					toolUses,
					truncated: truncation.truncated,
				},
			};
		},

		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("claude "));
			if (args.resumeSessionId) {
				text += theme.fg("warning", "resume ");
				text += theme.fg("dim", args.resumeSessionId.slice(0, 8) + "… ");
			}
			const prompt = args.prompt?.length > 100 ? args.prompt.slice(0, 100) + "…" : args.prompt;
			text += theme.fg("accent", `"${prompt}"`);
			if (args.model) text += theme.fg("dim", ` model=${args.model}`);
			if (args.maxTurns) text += theme.fg("dim", ` maxTurns=${args.maxTurns}`);
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded, isPartial }, theme) {
			const details = result.details as any;

			// ── Live progress while streaming ──
			if (isPartial) {
				const elapsed = details?.startTime ? formatDuration(Date.now() - details.startTime) : "…";
				const responseTokens = details?.responseTokens ?? 0;
				const tools = (details?.toolUses ?? []) as string[];
				const cost = details?.cost ?? 0;
				const sid = details?.sessionId ?? "";
				const phase = details?.phase ?? "thinking";

				let status = theme.fg("warning", "⟳ Claude Code");
				status += theme.fg("dim", ` ${elapsed}`);
				if (cost > 0) status += theme.fg("dim", ` $${cost.toFixed(4)}`);

				if (phase === "responding" && responseTokens > 0) {
					status += theme.fg("dim", ` ~${responseTokens} tokens`);
				}

				if (phase === "thinking") {
					status += theme.fg("dim", " thinking…");
				} else if (phase === "tools") {
					status += theme.fg("dim", " working…");
				}

				if (tools.length > 0) {
					status += "\n" + theme.fg("dim", `  tools: ${compressToolChain(tools)}`);
				}

				if (sid) {
					status += "\n" + theme.fg("dim", `  session: ${sid}`);
				}

				return new Text(status, 0, 0);
			}

			// ── Final result ──
			if (details?.error) {
				return new Text(theme.fg("error", `Error: ${details.error}`), 0, 0);
			}

			if (details?.cancelled) {
				let text = theme.fg("warning", "Cancelled");
				if (details.sessionId) text += theme.fg("dim", ` session: ${details.sessionId}`);
				return new Text(text, 0, 0);
			}

			let header = theme.fg("success", "✓ Claude Code");
			if (details?.elapsed) header += theme.fg("dim", ` ${formatDuration(details.elapsed)}`);
			if (details?.tokens) header += theme.fg("dim", ` ~${details.tokens} tokens`);
			if (details?.cost) header += theme.fg("dim", ` $${details.cost.toFixed(4)}`);
			if (details?.turns) header += theme.fg("dim", ` ${details.turns} turns`);
			if (details?.truncated) header += theme.fg("warning", " (truncated)");

			if (details?.toolUses?.length > 0) {
				header += "\n" + theme.fg("dim", `  tools: ${compressToolChain(details.toolUses)}`);
			}

			if (details?.outputFile) {
				header += "\n" + theme.fg("accent", `  → ${details.outputFile}`);
			}

			if (details?.sessionId) {
				header += "\n" + theme.fg("dim", `  session: ${details.sessionId}`);
			}

			if (details?.outputFile) {
				return new Text(header, 0, 0);
			}

			if (!expanded) {
				const firstLine = result.content[0]?.type === "text" ? result.content[0].text.split("\n")[0] : "";
				const preview = firstLine.length > 120 ? firstLine.slice(0, 120) + "…" : firstLine;
				header += "\n" + theme.fg("dim", preview);
				return new Text(header, 0, 0);
			}

			const content = result.content[0]?.type === "text" ? result.content[0].text : "";
			return new Text(header + "\n" + content, 0, 0);
		},
	});
}
