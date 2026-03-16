#!/bin/bash
# Refresh MCP bearer tokens from Claude Code's keychain
# Run this after re-connecting to MCP servers in Claude Code

set -euo pipefail

MCP_CONFIG="$HOME/.pi/agent/mcp.json"

# Map: Claude Code keychain account → pi MCP server name
declare -A SERVER_MAP=(
  ["polar|307aba93776d7813"]="polar"
  ["polar-sandbox|7eca2f018188d287"]="polar-sandbox"
  ["linear|638130d5ab3558f4"]="linear-server"
  ["figma|d39d3b6252bc1ac5"]="figma"
)

echo "Refreshing MCP tokens from Claude Code keychain..."
echo ""

for acct in "${!SERVER_MAP[@]}"; do
  server="${SERVER_MAP[$acct]}"
  
  token_json=$(security find-generic-password -s "Codex MCP Credentials" -a "$acct" -w 2>/dev/null || true)
  
  if [ -z "$token_json" ]; then
    echo "⚠ $server: not found in keychain"
    continue
  fi
  
  access_token=$(echo "$token_json" | python3 -c "import sys,json; print(json.load(sys.stdin)['token_response']['access_token'])")
  expires_at=$(echo "$token_json" | python3 -c "import sys,json,time; exp=json.load(sys.stdin).get('expires_at',0); remaining=(exp-time.time()*1000)/1000/3600; print(f'{remaining:.1f}h')")
  
  echo "✓ $server: token updated (expires in $expires_at)"
  
  # Update mcp.json in-place using python
  python3 -c "
import json
with open('$MCP_CONFIG') as f:
    config = json.load(f)
config['mcpServers']['$server']['bearerToken'] = '$access_token'
with open('$MCP_CONFIG', 'w') as f:
    json.dump(config, f, indent=2)
    f.write('\n')
"
done

echo ""
echo "Done. Restart pi to pick up the new tokens."
