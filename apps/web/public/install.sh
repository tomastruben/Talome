#!/usr/bin/env bash
set -euo pipefail

# ── Colours ───────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; BOLD='\033[1m'; RESET='\033[0m'

info()    { echo -e "${CYAN}[talome]${RESET} $*"; }
success() { echo -e "${GREEN}[talome]${RESET} $*"; }
warn()    { echo -e "${YELLOW}[talome]${RESET} $*"; }
fatal()   { echo -e "${RED}[talome] ERROR:${RESET} $*" >&2; exit 1; }

TALOME_DIR="${HOME}/.talome"
TALOME_IMAGE="ghcr.io/talomehq/talome:latest"
API_PORT="${TALOME_API_PORT:-4000}"
DASHBOARD_PORT="${TALOME_DASHBOARD_PORT:-3000}"

# ── Update subcommand ─────────────────────────────────────────────────────────
if [ "${1:-}" = "update" ]; then
  info "Updating Talome to the latest version..."
  docker pull "${TALOME_IMAGE}" || fatal "Failed to pull latest image."
  cd "${TALOME_DIR}"
  docker compose up -d || fatal "Failed to restart Talome after update."
  success "Talome updated and restarted successfully!"
  echo ""
  echo -e "  ${BOLD}Dashboard:${RESET}  http://localhost:${DASHBOARD_PORT}"
  echo ""
  exit 0
fi

# ── Header ────────────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}╔══════════════════════════════════════╗${RESET}"
echo -e "${BOLD}║      Talome Installer v1.0.0         ║${RESET}"
echo -e "${BOLD}║   Your AI-powered home server OS     ║${RESET}"
echo -e "${BOLD}╚══════════════════════════════════════╝${RESET}"
echo ""

# ── OS detection ─────────────────────────────────────────────────────────────
OS="$(uname -s)"
ARCH="$(uname -m)"
info "Detected OS: ${OS} (${ARCH})"

# ── Port conflict detection ──────────────────────────────────────────────────
check_port() {
  local port="$1"
  local name="$2"
  if command -v lsof &>/dev/null; then
    if lsof -iTCP:"${port}" -sTCP:LISTEN -P -n &>/dev/null 2>&1; then
      fatal "Port ${port} (${name}) is already in use. Free it or set TALOME_${name}_PORT to use a different port.\n       Example: TALOME_API_PORT=5000 bash install.sh"
    fi
  elif command -v ss &>/dev/null; then
    if ss -tlnp 2>/dev/null | grep -q ":${port} "; then
      fatal "Port ${port} (${name}) is already in use. Free it or set TALOME_${name}_PORT to use a different port.\n       Example: TALOME_API_PORT=5000 bash install.sh"
    fi
  fi
  # If neither tool is available, skip check (Docker will report the conflict)
}

check_port "${API_PORT}" "API"
check_port "${DASHBOARD_PORT}" "DASHBOARD"
success "Ports ${API_PORT} and ${DASHBOARD_PORT} are available."

# ── Docker check / install ────────────────────────────────────────────────────
check_docker() {
  command -v docker &>/dev/null
}

install_docker_linux() {
  info "Docker not found. Installing via get.docker.com..."
  curl -fsSL https://get.docker.com | sh
  if [ -n "${SUDO_USER:-}" ]; then
    usermod -aG docker "${SUDO_USER}"
    warn "Added ${SUDO_USER} to docker group. Log out and back in for it to take effect."
  fi
}

install_docker_mac() {
  if command -v brew &>/dev/null; then
    info "Installing Docker Desktop via Homebrew..."
    brew install --cask docker
    info "Opening Docker Desktop..."
    open -a Docker
    info "Waiting for Docker to start (this may take 30s)..."
    local i=0
    while ! docker info &>/dev/null 2>&1; do
      sleep 2
      i=$((i+2))
      if [ $i -ge 60 ]; then
        fatal "Docker didn't start within 60 seconds. Please start Docker Desktop manually and re-run."
      fi
    done
  else
    fatal "Homebrew not found. Install Docker Desktop from https://docker.com/products/docker-desktop and re-run."
  fi
}

if ! check_docker; then
  if [ "${OS}" = "Darwin" ]; then
    install_docker_mac
  elif [ "${OS}" = "Linux" ]; then
    install_docker_linux
  else
    fatal "Unsupported OS: ${OS}. Install Docker manually from https://docs.docker.com/get-docker/"
  fi
else
  info "Docker found: $(docker --version)"
fi

# ── Docker daemon running? ────────────────────────────────────────────────────
if ! docker info &>/dev/null 2>&1; then
  if [ "${OS}" = "Darwin" ]; then
    info "Docker daemon not running. Starting Docker Desktop..."
    open -a Docker
    info "Waiting for Docker to start..."
    i=0
    while ! docker info &>/dev/null 2>&1; do
      sleep 2
      i=$((i+2))
      if [ $i -ge 60 ]; then
        fatal "Docker didn't start within 60 seconds. Please start Docker Desktop manually and re-run."
      fi
    done
  elif [ "${OS}" = "Linux" ]; then
    info "Starting Docker daemon..."
    sudo systemctl start docker || fatal "Could not start Docker. Try: sudo systemctl start docker"
  fi
fi

success "Docker is running."

# ── Create Talome directory ─────────────────────────────────────────────────
mkdir -p "${TALOME_DIR}"
info "Talome config directory: ${TALOME_DIR}"

# ── Generate secret key (first run only) ─────────────────────────────────────
ENV_FILE="${TALOME_DIR}/.env"
if [ ! -f "${ENV_FILE}" ]; then
  TALOME_SECRET=$(openssl rand -hex 32)
  touch "${ENV_FILE}"
  chmod 600 "${ENV_FILE}"
  echo "TALOME_SECRET=${TALOME_SECRET}" > "${ENV_FILE}"
  info "Generated secret key → ${ENV_FILE}"
else
  info "Existing .env found at ${ENV_FILE}"
fi

# ── Write docker-compose.yml ────────────────────────────────────────────────
COMPOSE_FILE="${TALOME_DIR}/docker-compose.yml"
if [ ! -f "${COMPOSE_FILE}" ]; then
  cat > "${COMPOSE_FILE}" << EOF
services:
  talome:
    image: ${TALOME_IMAGE}
    container_name: talome
    restart: unless-stopped
    ports:
      - "${API_PORT}:4000"
      - "${DASHBOARD_PORT}:3000"
    volumes:
      - talome-data:/app/data
      - /var/run/docker.sock:/var/run/docker.sock
    env_file:
      - .env
    environment:
      - NODE_ENV=production

volumes:
  talome-data:
EOF
  success "Created ${COMPOSE_FILE}"
else
  info "Existing docker-compose.yml found at ${COMPOSE_FILE}"
fi

# ── Pull image ────────────────────────────────────────────────────────────────
info "Pulling Talome image (${TALOME_IMAGE})..."
docker pull "${TALOME_IMAGE}" || fatal "Failed to pull image. Check your internet connection."

# ── Start containers ──────────────────────────────────────────────────────────
info "Starting Talome..."
cd "${TALOME_DIR}"
docker compose up -d || fatal "Failed to start Talome. Check 'docker compose logs' in ${TALOME_DIR}"

# ── Wait for health ───────────────────────────────────────────────────────────
info "Waiting for Talome to be ready..."
HEALTH_URL="http://localhost:${API_PORT}/api/health"
MAX_WAIT=120
WAITED=0

while true; do
  STATUS=$(curl -s -o /dev/null -w "%{http_code}" "${HEALTH_URL}" 2>/dev/null || echo "000")
  if [ "${STATUS}" = "200" ] || [ "${STATUS}" = "503" ]; then
    break
  fi
  sleep 2
  WAITED=$((WAITED+2))
  if [ $WAITED -ge $MAX_WAIT ]; then
    warn "Talome is taking longer than expected. Check logs with: docker logs talome"
    break
  fi
done

# ── Done ──────────────────────────────────────────────────────────────────────
echo ""
success "Talome is running!"
echo ""
echo -e "  ${BOLD}Dashboard:${RESET}  http://localhost:${DASHBOARD_PORT}"
echo -e "  ${BOLD}API:${RESET}        http://localhost:${API_PORT}"
echo ""
echo -e "  ${BOLD}Config dir:${RESET} ${TALOME_DIR}"
echo -e "  ${BOLD}View logs:${RESET}  docker logs -f talome"
echo -e "  ${BOLD}Stop:${RESET}       cd ${TALOME_DIR} && docker compose down"
echo -e "  ${BOLD}Update:${RESET}     curl -fsSL https://get.talome.dev | bash -s -- update"
echo ""

# Open browser
OPEN_URL="http://localhost:${DASHBOARD_PORT}"
if [ "${OS}" = "Darwin" ]; then
  open "${OPEN_URL}" 2>/dev/null || true
elif [ "${OS}" = "Linux" ]; then
  xdg-open "${OPEN_URL}" 2>/dev/null || true
fi
