#!/bin/sh
# Run an isolated Talome for UI work and design review.
# (The dashboard uses webpack: Turbopack rejects the symlinked node_modules
# that git worktrees share.)
#
#   scripts/sandbox.sh core        # core API on :4210
#   scripts/sandbox.sh dashboard   # dashboard on :3210 (proxies to :4210)
#
# Isolation: its own HOME (so ~/.talome, stores, backups, PID files live in
# the sandbox), its own SQLite database, its own ports, and a Docker socket
# path that does not exist — the sandbox can never touch real containers,
# Caddy, Avahi or another Talome instance. Docker-backed panels show their
# empty/error states; everything else works.
set -e

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SANDBOX_HOME="${TALOME_SANDBOX_HOME:-${TMPDIR:-/tmp}/talome-sandbox}"
CORE_PORT="${TALOME_SANDBOX_CORE_PORT:-4210}"
DASHBOARD_PORT="${TALOME_SANDBOX_DASHBOARD_PORT:-3210}"

mkdir -p "$SANDBOX_HOME"
if [ ! -f "$SANDBOX_HOME/secret" ]; then
  od -An -tx1 -N32 /dev/urandom | tr -d ' \n' > "$SANDBOX_HOME/secret"
  chmod 600 "$SANDBOX_HOME/secret"
fi

case "$1" in
  core)
    cd "$ROOT/apps/core"
    exec env \
      HOME="$SANDBOX_HOME" \
      DATABASE_PATH="$SANDBOX_HOME/talome.db" \
      TALOME_SECRET="$(cat "$SANDBOX_HOME/secret")" \
      CORE_PORT="$CORE_PORT" \
      TERMINAL_DAEMON_PORT="$((CORE_PORT + 1))" \
      DOCKER_SOCKET="$SANDBOX_HOME/no-docker.sock" \
      DOCKER_HOST="unix://$SANDBOX_HOME/no-docker.sock" \
      TALOME_SELF_BACKUP_DISABLED=1 \
      DASHBOARD_ORIGIN="http://localhost:$DASHBOARD_PORT" \
      pnpm exec tsx src/index.ts
    ;;
  dashboard)
    cd "$ROOT/apps/dashboard"
    exec env \
      CORE_BACKEND_URL="http://127.0.0.1:$CORE_PORT" \
      NEXT_PUBLIC_CORE_PORT="$CORE_PORT" \
      pnpm exec next dev --webpack --hostname localhost --port "$DASHBOARD_PORT"
    ;;
  *)
    echo "usage: $0 core|dashboard" >&2
    exit 2
    ;;
esac
