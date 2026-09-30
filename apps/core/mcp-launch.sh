#!/bin/sh
# Wrapper to launch the compiled Talome MCP server with the correct Node.js
# and environment variables from .env (needed for TALOME_SECRET).
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

MCP_ENTRY="$SCRIPT_DIR/dist/mcp-stdio.js"

if [ ! -f "$MCP_ENTRY" ]; then
  echo "Talome MCP build missing: run 'pnpm --filter @talome/core build' first." >&2
  exit 1
fi

if [ -f "$SCRIPT_DIR/.env" ]; then
  exec /usr/local/bin/node --env-file="$SCRIPT_DIR/.env" "$MCP_ENTRY" "$@"
fi

exec /usr/local/bin/node "$MCP_ENTRY" "$@"
