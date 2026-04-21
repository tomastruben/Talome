#!/bin/bash
# Backward-compatible wrapper — delegates to the unified supervisor.
# The supervisor handles mode detection, process spawning, health checks,
# and graduated escalation (restart → diagnose → revert → stop).
#
# Mode is read from ~/.talome/server-mode or passed via --mode=dev|build.

DIR="$(cd "$(dirname "$0")" && pwd)"
CORE="$(cd "$DIR/../apps/core" && pwd)"
exec "$CORE/node_modules/.bin/tsx" "$DIR/supervisor.ts" "$@"
