#!/bin/sh
# Wrapper to launch the Talome MCP server with the correct Node.js
# and environment variables from .env (needed for TALOME_SECRET).
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Source .env if it exists (provides TALOME_SECRET, etc.)
if [ -f "$SCRIPT_DIR/.env" ]; then
  set -a
  . "$SCRIPT_DIR/.env"
  set +a
fi

exec /usr/local/bin/node "$SCRIPT_DIR/node_modules/tsx/dist/cli.mjs" "$SCRIPT_DIR/src/mcp-stdio.ts" "$@"
