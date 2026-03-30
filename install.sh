#!/usr/bin/env bash
set -euo pipefail

# ── Colours & symbols ────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'
BOLD='\033[1m'; DIM='\033[2m'; RESET='\033[0m'
CHECK="${GREEN}✓${RESET}"; CROSS="${RED}✗${RESET}"; ARROW="${CYAN}→${RESET}"

info()    { echo -e "  ${ARROW} $*"; }
success() { echo -e "  ${CHECK} $*"; }

# When piped via curl|bash, stdin is the script itself — read from /dev/tty instead
ask() { read -r "$@" </dev/tty; }
warn()    { echo -e "  ${YELLOW}!${RESET} $*"; }
fatal()   { echo -e "  ${CROSS} $*" >&2; exit 1; }

step() {
  echo ""
  echo -e "  ${BOLD}$1${RESET}"
  echo -e "  ${DIM}$(printf '%.0s─' $(seq 1 ${#1}))${RESET}"
}

TALOME_DIR="${HOME}/.talome"
TALOME_VERSION="0.1.0"
TALOME_IMAGE="ghcr.io/tomastruben/talome:latest"
API_PORT="${TALOME_API_PORT:-4000}"
DASHBOARD_PORT="${TALOME_DASHBOARD_PORT:-3000}"

# ── Update subcommand ─────────────────────────────────────────────────────────
if [ "${1:-}" = "update" ]; then
  echo ""
  echo -e "  ${BOLD}Updating Talome...${RESET}"
  echo ""
  info "Pulling latest image..."
  docker pull "${TALOME_IMAGE}" || fatal "Failed to pull latest image."
  cd "${TALOME_DIR}"
  info "Restarting containers..."
  docker compose up -d || fatal "Failed to restart Talome after update."
  echo ""
  success "Talome updated successfully!"
  echo ""
  echo -e "  ${DIM}Dashboard${RESET}  ${BOLD}http://localhost:${DASHBOARD_PORT}${RESET}"
  echo ""
  exit 0
fi

# ── ASCII art header ─────────────────────────────────────────────────────────
echo ""
echo -e "${CYAN}"
cat << 'ART'
        ████████╗ █████╗ ██╗      ██████╗ ███╗   ███╗███████╗
        ╚══██╔══╝██╔══██╗██║     ██╔═══██╗████╗ ████║██╔════╝
           ██║   ███████║██║     ██║   ██║██╔████╔██║█████╗
           ██║   ██╔══██║██║     ██║   ██║██║╚██╔╝██║██╔══╝
           ██║   ██║  ██║███████╗╚██████╔╝██║ ╚═╝ ██║███████╗
           ╚═╝   ╚═╝  ╚═╝╚══════╝ ╚═════╝ ╚═╝     ╚═╝╚══════╝
ART
echo -e "${RESET}"
echo -e "        ${DIM}The self-evolving home server  ·  v0.1.0 public alpha${RESET}"
echo ""

# ── OS detection ─────────────────────────────────────────────────────────────
step "Detecting system"

OS="$(uname -s)"
ARCH="$(uname -m)"

case "${OS}" in
  Darwin)
    OS_PRETTY="macOS"
    # Detect macOS version
    if command -v sw_vers &>/dev/null; then
      OS_VERSION=$(sw_vers -productVersion 2>/dev/null || echo "")
      OS_PRETTY="macOS ${OS_VERSION}"
    fi
    # Detect Docker runtime
    if [ -e "${HOME}/.orbstack" ] || docker context ls 2>/dev/null | grep -q orbstack; then
      DOCKER_RUNTIME="OrbStack"
    elif [ -e "/Applications/Docker.app" ]; then
      DOCKER_RUNTIME="Docker Desktop"
    else
      DOCKER_RUNTIME="Docker"
    fi
    ;;
  Linux)
    OS_PRETTY="Linux"
    if [ -f /etc/os-release ]; then
      . /etc/os-release
      OS_PRETTY="${PRETTY_NAME:-Linux}"
    fi
    DOCKER_RUNTIME="Docker Engine"
    ;;
  *)
    OS_PRETTY="${OS}"
    DOCKER_RUNTIME="Docker"
    ;;
esac

case "${ARCH}" in
  x86_64)  ARCH_PRETTY="x86_64 (amd64)" ;;
  aarch64|arm64) ARCH_PRETTY="ARM64 (Apple Silicon / aarch64)" ;;
  *) ARCH_PRETTY="${ARCH}" ;;
esac

# Detect memory
if [ "${OS}" = "Darwin" ]; then
  TOTAL_MEM=$(( $(sysctl -n hw.memsize 2>/dev/null || echo 0) / 1073741824 ))
elif [ -f /proc/meminfo ]; then
  TOTAL_MEM=$(( $(grep MemTotal /proc/meminfo | awk '{print $2}') / 1048576 ))
else
  TOTAL_MEM=0
fi

# Detect disk
if command -v df &>/dev/null; then
  FREE_DISK=$(df -BG "${HOME}" 2>/dev/null | awk 'NR==2{print $4}' | tr -d 'G' || echo "?")
  if [ "${FREE_DISK}" = "?" ]; then
    FREE_DISK=$(df -g "${HOME}" 2>/dev/null | awk 'NR==2{print $4}' || echo "?")
  fi
fi

success "OS:      ${OS_PRETTY}"
success "Arch:    ${ARCH_PRETTY}"
if [ "${TOTAL_MEM}" -gt 0 ] 2>/dev/null; then
  success "Memory:  ${TOTAL_MEM} GB"
fi
if [ "${FREE_DISK:-?}" != "?" ]; then
  success "Disk:    ${FREE_DISK} GB free"
fi

# Check minimum requirements
if [ "${TOTAL_MEM}" -gt 0 ] 2>/dev/null && [ "${TOTAL_MEM}" -lt 2 ]; then
  warn "Talome recommends at least 2 GB of RAM (found ${TOTAL_MEM} GB)"
fi

# ── Port conflict detection ──────────────────────────────────────────────────
step "Checking ports"

check_port() {
  local port="$1"
  local name="$2"
  if command -v lsof &>/dev/null; then
    if lsof -iTCP:"${port}" -sTCP:LISTEN -P -n &>/dev/null 2>&1; then
      fatal "Port ${port} (${name}) is in use. Set TALOME_${name}_PORT to change it."
    fi
  elif command -v ss &>/dev/null; then
    if ss -tlnp 2>/dev/null | grep -q ":${port} "; then
      fatal "Port ${port} (${name}) is in use. Set TALOME_${name}_PORT to change it."
    fi
  fi
}

check_port "${API_PORT}" "API"
check_port "${DASHBOARD_PORT}" "DASHBOARD"
success "Port ${API_PORT} ${DIM}(API)${RESET} available"
success "Port ${DASHBOARD_PORT} ${DIM}(Dashboard)${RESET} available"

# ── Docker check / install ────────────────────────────────────────────────────
step "Checking Docker"

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

install_homebrew() {
  echo ""
  info "Homebrew is the standard macOS package manager."
  printf "  ${ARROW} Install Homebrew? ${BOLD}[Y/n]${RESET} "
  ask REPLY
  REPLY="${REPLY:-Y}"
  if [[ "${REPLY}" =~ ^[Yy]$ ]]; then
    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)" </dev/tty
    # Add Homebrew to PATH for Apple Silicon
    if [ -f /opt/homebrew/bin/brew ]; then
      eval "$(/opt/homebrew/bin/brew shellenv)"
    fi
    success "Homebrew installed"
  else
    fatal "Homebrew is required to install Docker on macOS. Install it manually: https://brew.sh"
  fi
}

wait_for_docker() {
  local label="$1"
  info "Waiting for ${label} to start..."
  local i=0
  while ! docker info &>/dev/null 2>&1; do
    i=$(( i / 2 % 10 ))
    printf "\r  ${CYAN}${SPINNER:$i:1}${RESET} Starting ${label}...  " >&2
    sleep 2
    i=$((i+2))
    if [ $i -ge 90 ]; then
      printf "\r                              \r" >&2
      fatal "${label} didn't start within 90 seconds. Start it manually and re-run."
    fi
  done
  printf "\r                              \r" >&2
}

install_docker_mac() {
  # Ensure Homebrew is available
  if ! command -v brew &>/dev/null; then
    install_homebrew
  fi

  echo ""
  info "Docker is required to run Talome. Pick your runtime:"
  echo ""
  echo -e "    ${BOLD}1)${RESET} OrbStack  ${DIM}— fast, lightweight, native Apple Silicon ${GREEN}(recommended)${RESET}"
  echo -e "    ${BOLD}2)${RESET} Docker Desktop  ${DIM}— official Docker runtime${RESET}"
  echo ""
  printf "  ${ARROW} Choose ${BOLD}[1/2]${RESET}: "
  ask CHOICE
  CHOICE="${CHOICE:-1}"

  case "${CHOICE}" in
    1)
      info "Installing OrbStack..."
      brew install --cask orbstack
      info "Opening OrbStack..."
      open -a OrbStack
      DOCKER_RUNTIME="OrbStack"
      wait_for_docker "OrbStack"
      ;;
    2)
      info "Installing Docker Desktop..."
      brew install --cask docker
      info "Opening Docker Desktop..."
      open -a Docker
      DOCKER_RUNTIME="Docker Desktop"
      wait_for_docker "Docker Desktop"
      ;;
    *)
      fatal "Invalid choice. Re-run the installer."
      ;;
  esac
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
  DOCKER_VER=$(docker --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)
  success "Docker ${DOCKER_VER} ${DIM}(${DOCKER_RUNTIME})${RESET}"
fi

# ── Docker daemon running? ────────────────────────────────────────────────────
if ! docker info &>/dev/null 2>&1; then
  if [ "${OS}" = "Darwin" ]; then
    info "Docker daemon not running. Starting ${DOCKER_RUNTIME}..."
    open -a Docker
    info "Waiting for Docker to start..."
    i=0
    while ! docker info &>/dev/null 2>&1; do
      sleep 2
      i=$((i+2))
      if [ $i -ge 60 ]; then
        fatal "Docker didn't start within 60 seconds. Start ${DOCKER_RUNTIME} manually and re-run."
      fi
    done
  elif [ "${OS}" = "Linux" ]; then
    info "Starting Docker daemon..."
    sudo systemctl start docker || fatal "Could not start Docker. Try: sudo systemctl start docker"
  fi
fi

success "Docker daemon is running"

# ── Create Talome directory ─────────────────────────────────────────────────
step "Setting up Talome"

mkdir -p "${TALOME_DIR}"
success "Config directory: ${DIM}${TALOME_DIR}${RESET}"

# ── Generate secret key (first run only) ─────────────────────────────────────
ENV_FILE="${TALOME_DIR}/.env"
if [ ! -f "${ENV_FILE}" ]; then
  TALOME_SECRET=$(openssl rand -hex 32)
  touch "${ENV_FILE}"
  chmod 600 "${ENV_FILE}"
  echo "TALOME_SECRET=${TALOME_SECRET}" > "${ENV_FILE}"
  success "Generated encryption key"
else
  success "Existing config found"
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
  success "Created docker-compose.yml"
else
  success "Existing docker-compose.yml found"
fi

# ── Pull image ────────────────────────────────────────────────────────────────
step "Pulling Talome"

info "Downloading ${DIM}${TALOME_IMAGE}${RESET}"
docker pull "${TALOME_IMAGE}" || fatal "Failed to pull image. Check your internet connection."
success "Image ready"

# ── Start containers ──────────────────────────────────────────────────────────
step "Starting Talome"

cd "${TALOME_DIR}"
docker compose up -d || fatal "Failed to start. Check 'docker compose logs' in ${TALOME_DIR}"

# ── Wait for health ───────────────────────────────────────────────────────────
info "Waiting for services to be ready..."
HEALTH_URL="http://localhost:${API_PORT}/api/health"
MAX_WAIT=120
WAITED=0
SPINNER="⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"

while true; do
  STATUS=$(curl -s -o /dev/null -w "%{http_code}" "${HEALTH_URL}" 2>/dev/null || echo "000")
  if [ "${STATUS}" = "200" ] || [ "${STATUS}" = "503" ]; then
    break
  fi
  # Spinner
  i=$(( WAITED / 2 % 10 ))
  printf "\r  ${CYAN}${SPINNER:$i:1}${RESET} Starting...  " >&2
  sleep 2
  WAITED=$((WAITED+2))
  if [ $WAITED -ge $MAX_WAIT ]; then
    printf "\r" >&2
    warn "Talome is taking longer than expected. Check: docker logs talome"
    break
  fi
done
printf "\r                    \r" >&2

success "Talome is running!"

# ── Done ──────────────────────────────────────────────────────────────────────
echo ""
echo -e "  ${BOLD}${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
echo ""
echo -e "  ${BOLD}Open Talome${RESET}   ${CYAN}http://localhost:${DASHBOARD_PORT}${RESET}"
echo ""
echo -e "  ${DIM}Config${RESET}        ${TALOME_DIR}"
echo -e "  ${DIM}Logs${RESET}          docker logs -f talome"
echo -e "  ${DIM}Stop${RESET}          cd ${TALOME_DIR} && docker compose down"
echo -e "  ${DIM}Update${RESET}        curl -fsSL https://get.talome.dev | bash -s -- update"
echo ""
echo -e "  ${BOLD}${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
echo ""

# Open browser
OPEN_URL="http://localhost:${DASHBOARD_PORT}"
if [ "${OS}" = "Darwin" ]; then
  open "${OPEN_URL}" 2>/dev/null || true
elif [ "${OS}" = "Linux" ]; then
  xdg-open "${OPEN_URL}" 2>/dev/null || true
fi
