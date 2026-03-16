# MCP Server Setup Guide

How to add MCP servers to pi via the `pi-mcp-adapter`.

## Config files

| Scope | File | Use case |
|-------|------|----------|
| **Global** | `~/.pi/agent/mcp.json` | Servers used across all projects |
| **Project** | `<project>/.pi/mcp.json` | Servers specific to one project |

Both files share the same format. Project configs override global ones.

> **⚠️ Security:** `mcp.json` contains bearer tokens and secrets. It's in `.gitignore` — never commit it.

## Server types

### HTTP (remote URL)

Most cloud MCP servers (Figma, Linear, Polar, Sanity, etc.) use HTTP transport.

```json
{
  "mcpServers": {
    "server-name": {
      "url": "https://example.com/mcp"
    }
  }
}
```

With bearer auth:

```json
{
  "mcpServers": {
    "server-name": {
      "url": "https://example.com/mcp",
      "auth": "bearer",
      "bearerToken": "your-token-here"
    }
  }
}
```

With OAuth (tokens stored in `~/.pi/agent/mcp-oauth/<server>/tokens.json`):

```json
{
  "mcpServers": {
    "server-name": {
      "url": "https://example.com/mcp",
      "auth": "oauth"
    }
  }
}
```

### Stdio (local process)

Servers that run as local commands (npx, bun, python, etc.):

```json
{
  "mcpServers": {
    "server-name": {
      "command": "npx",
      "args": ["-y", "package-name@latest"],
      "env": {
        "API_KEY": "your-key"
      }
    }
  }
}
```

## Getting tokens from Claude Code

If you already have MCP servers connected in Claude Code, you can reuse their OAuth tokens. Claude Code stores them in the macOS Keychain under `"Codex MCP Credentials"`.

### Extract a token

```bash
# List all MCP tokens
security dump-keychain 2>/dev/null | grep -A2 "Codex MCP Credentials"

# Get a specific server's token (e.g., figma)
security find-generic-password -s "Codex MCP Credentials" -a "figma|<hash>" -w
```

The output is JSON containing `token_response.access_token` — use that as the `bearerToken`.

### Token format in keychain

```json
{
  "server_name": "figma",
  "url": "https://mcp.figma.com/mcp",
  "client_id": "...",
  "token_response": {
    "access_token": "figu_...",
    "token_type": "bearer",
    "expires_in": 7776000,
    "refresh_token": "figur_..."
  },
  "expires_at": 1779744481902
}
```

### Expiration

Tokens expire. Check before using:

| Server | Typical expiry |
|--------|---------------|
| Figma | 90 days |
| Linear | 7 days |
| Polar | 1 hour |

Short-lived tokens (Polar) need frequent refresh. Re-connect in Claude Code to get fresh tokens, then extract again.

## Config reference

| Field | Type | Description |
|-------|------|-------------|
| `url` | string | Server URL (HTTP servers) |
| `command` | string | Executable to run (stdio servers) |
| `args` | string[] | Command arguments (stdio) |
| `env` | object | Environment variables (stdio) |
| `cwd` | string | Working directory (stdio) |
| `headers` | object | Custom HTTP headers |
| `auth` | `"bearer"` \| `"oauth"` | Authentication method |
| `bearerToken` | string | Static bearer token |
| `bearerTokenEnv` | string | Env var name for bearer token |
| `lifecycle` | `"lazy"` \| `"eager"` \| `"keep-alive"` | Connection strategy (default: `lazy`) |
| `idleTimeout` | number | Minutes before idle disconnect |
| `debug` | boolean | Show server stderr |

### Lifecycle modes

- **lazy** (default) — connects on first tool call, disconnects after idle
- **eager** — connects at session start, no auto-disconnect
- **keep-alive** — connects at start, auto-reconnects if dropped

## Verification

After adding a server, reload and test:

1. Run `/reload` in pi
2. Use `mcp({ connect: "server-name" })` to test
3. Use `mcp({ server: "server-name" })` to list tools
