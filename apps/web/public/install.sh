#!/usr/bin/env bash
set -euo pipefail

# ── Colours & symbols ────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'
BOLD='\033[1m'; DIM='\033[2m'; RESET='\033[0m'
CHECK="${GREEN}✓${RESET}"; CROSS="${RED}✗${RESET}"; ARROW="${CYAN}→${RESET}"
SPINNER="⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"

info()    { echo -e "  ${ARROW} $*"; }
success() { echo -e "  ${CHECK} $*"; }
ask()     { read -r "$@" </dev/tty; }
warn()    { echo -e "  ${YELLOW}!${RESET} $*"; }
fatal()   { echo -e "  ${CROSS} $*" >&2; exit 1; }

step() {
  echo ""
  echo -e "  ${BOLD}$1${RESET}"
  echo -e "  ${DIM}$(printf '%.0s─' $(seq 1 ${#1}))${RESET}"
}

TALOME_DIR="${HOME}/.talome"
TALOME_VERSION="0.1.0"
TALOME_REPO="https://github.com/tomastruben/Talome.git"
API_PORT="${TALOME_API_PORT:-4000}"
DASHBOARD_PORT="${TALOME_DASHBOARD_PORT:-3000}"
TERMINAL_PORT="4001"
INSTALL_DIR="${TALOME_DIR}/server"

# ── Update subcommand ─────────────────────────────────────────────────────────
if [ "${1:-}" = "update" ]; then
  echo ""
  echo -e "  ${BOLD}Updating Talome...${RESET}"
  echo ""
  if [ ! -d "${INSTALL_DIR}" ]; then
    fatal "Talome not found at ${INSTALL_DIR}. Run the installer first."
  fi
  cd "${INSTALL_DIR}"
  info "Pulling latest changes..."
  git pull --ff-only origin main || fatal "Git pull failed. Resolve conflicts manually."
  info "Installing dependencies..."
  pnpm install --frozen-lockfile 2>/dev/null || pnpm install
  info "Building..."
  pnpm build
  info "Restarting..."
  if [ "$(uname -s)" = "Linux" ] && command -v systemctl &>/dev/null; then
    sudo systemctl restart talome
  else
    # macOS — restart via launchctl
    launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/dev.talome.plist 2>/dev/null || true
    launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/dev.talome.plist
  fi
  echo ""
  success "Talome updated to latest!"
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
echo -e "        ${DIM}The self-evolving home server  ·  v${TALOME_VERSION} public alpha${RESET}"
echo ""

# ── OS detection ─────────────────────────────────────────────────────────────
step "Detecting system"

OS="$(uname -s)"
ARCH="$(uname -m)"

case "${OS}" in
  Darwin)
    OS_PRETTY="macOS"
    if command -v sw_vers &>/dev/null; then
      OS_VERSION=$(sw_vers -productVersion 2>/dev/null || echo "")
      OS_PRETTY="macOS ${OS_VERSION}"
    fi
    ;;
  Linux)
    OS_PRETTY="Linux"
    if [ -f /etc/os-release ]; then
      . /etc/os-release
      OS_PRETTY="${PRETTY_NAME:-Linux}"
    fi
    ;;
  *)
    OS_PRETTY="${OS}"
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
check_port "${TERMINAL_PORT}" "TERMINAL"
success "Port ${API_PORT} ${DIM}(API)${RESET} available"
success "Port ${DASHBOARD_PORT} ${DIM}(Dashboard)${RESET} available"
success "Port ${TERMINAL_PORT} ${DIM}(Terminal)${RESET} available"

# ── Docker check ──────────────────────────────────────────────────────────────
step "Checking Docker"

ensure_brew() {
  # Try to find Homebrew if it exists but isn't in PATH
  if ! command -v brew &>/dev/null; then
    if [ -f /opt/homebrew/bin/brew ]; then
      eval "$(/opt/homebrew/bin/brew shellenv)"
    elif [ -f /usr/local/bin/brew ]; then
      eval "$(/usr/local/bin/brew shellenv)"
    fi
  fi
  command -v brew &>/dev/null
}

wait_for_docker() {
  local label="$1"
  info "Waiting for ${label} to start..."
  local i=0
  while ! docker info &>/dev/null 2>&1; do
    local si=$(( i / 2 % 10 ))
    printf "\r  ${CYAN}${SPINNER:$si:1}${RESET} Starting ${label}...  " >&2
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
  echo ""
  info "Docker is required to run apps managed by Talome."
  echo ""
  echo -e "    ${BOLD}1)${RESET} OrbStack  ${DIM}— fast, lightweight, native Apple Silicon ${GREEN}(recommended)${RESET}"
  echo -e "       ${DIM}https://orbstack.dev/download${RESET}"
  echo ""
  echo -e "    ${BOLD}2)${RESET} Docker Desktop  ${DIM}— official Docker runtime${RESET}"
  echo -e "       ${DIM}https://docker.com/products/docker-desktop${RESET}"
  echo ""
  info "Install one of the above, start it, then re-run this installer."
  exit 1
}

install_docker_linux() {
  info "Docker not found. Installing via get.docker.com..."
  curl -fsSL https://get.docker.com | sh
  if [ -n "${SUDO_USER:-}" ]; then
    usermod -aG docker "${SUDO_USER}"
    warn "Added ${SUDO_USER} to docker group. Log out and back in for it to take effect."
  fi
}

if ! command -v docker &>/dev/null; then
  if [ "${OS}" = "Darwin" ]; then
    install_docker_mac
  elif [ "${OS}" = "Linux" ]; then
    install_docker_linux
  else
    fatal "Unsupported OS: ${OS}. Install Docker manually from https://docs.docker.com/get-docker/"
  fi
else
  DOCKER_VER=$(docker --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)
  success "Docker ${DOCKER_VER}"
fi

if ! docker info &>/dev/null 2>&1; then
  if [ "${OS}" = "Darwin" ]; then
    info "Docker daemon not running. Starting..."
    open -a OrbStack 2>/dev/null || open -a Docker 2>/dev/null || true
    wait_for_docker "Docker"
  elif [ "${OS}" = "Linux" ]; then
    info "Starting Docker daemon..."
    sudo systemctl start docker || fatal "Could not start Docker."
  fi
fi

success "Docker daemon is running"

# ── Node.js check / install ──────────────────────────────────────────────────
step "Checking Node.js"

MIN_NODE=22

check_node_version() {
  if ! command -v node &>/dev/null; then
    return 1
  fi
  local ver
  ver=$(node -v | tr -d 'v' | cut -d. -f1)
  [ "${ver}" -ge "${MIN_NODE}" ] 2>/dev/null
}

if ! check_node_version; then
  if [ "${OS}" = "Darwin" ]; then
    # Try Homebrew first if available
    if ensure_brew; then
      info "Installing Node.js ${MIN_NODE} via Homebrew..."
      brew install node@${MIN_NODE}
      brew link --overwrite node@${MIN_NODE} 2>/dev/null || true
    else
      # Direct binary install — no Homebrew, no sudo
      info "Installing Node.js ${MIN_NODE}..."
      NODE_ARCH="arm64"
      [ "${ARCH}" = "x86_64" ] && NODE_ARCH="x64"
      NODE_URL="https://nodejs.org/dist/v${MIN_NODE}.0.0/node-v${MIN_NODE}.0.0-darwin-${NODE_ARCH}.tar.gz"
      NODE_INSTALL="${TALOME_DIR}/node"
      mkdir -p "${NODE_INSTALL}"
      curl -fsSL "${NODE_URL}" | tar xz -C "${NODE_INSTALL}" --strip-components=1
      export PATH="${NODE_INSTALL}/bin:${PATH}"
      success "Node.js installed to ${NODE_INSTALL}"
    fi
  elif [ "${OS}" = "Linux" ]; then
    info "Installing Node.js ${MIN_NODE}..."
    NODE_ARCH="x64"
    [ "${ARCH}" = "aarch64" ] || [ "${ARCH}" = "arm64" ] && NODE_ARCH="arm64"
    NODE_URL="https://nodejs.org/dist/v${MIN_NODE}.0.0/node-v${MIN_NODE}.0.0-linux-${NODE_ARCH}.tar.xz"
    NODE_INSTALL="${TALOME_DIR}/node"
    mkdir -p "${NODE_INSTALL}"
    curl -fsSL "${NODE_URL}" | tar xJ -C "${NODE_INSTALL}" --strip-components=1
    export PATH="${NODE_INSTALL}/bin:${PATH}"
    success "Node.js installed to ${NODE_INSTALL}"
  fi
fi

if ! check_node_version; then
  fatal "Node.js ${MIN_NODE}+ is required. Found: $(node -v 2>/dev/null || echo 'none')"
fi

NODE_VER=$(node -v)
success "Node.js ${NODE_VER}"

# ── pnpm check / install ────────────────────────────────────────────────────
if ! command -v pnpm &>/dev/null; then
  info "Installing pnpm..."
  corepack enable 2>/dev/null || npm install -g pnpm 2>/dev/null || {
    curl -fsSL https://get.pnpm.io/install.sh | sh -
    export PNPM_HOME="${HOME}/.local/share/pnpm"
    export PATH="${PNPM_HOME}:${PATH}"
  }
fi
success "pnpm $(pnpm -v)"

# ── Git check ────────────────────────────────────────────────────────────────
if ! command -v git &>/dev/null; then
  if [ "${OS}" = "Darwin" ]; then
    # macOS ships git with Xcode CLT — trigger install if needed
    info "Git not found. macOS will prompt to install Xcode Command Line Tools..."
    xcode-select --install 2>/dev/null || true
    # Wait for it
    until command -v git &>/dev/null; do sleep 3; done
  elif [ "${OS}" = "Linux" ]; then
    info "Installing Git..."
    sudo apt-get install -y git 2>/dev/null || sudo dnf install -y git 2>/dev/null || sudo pacman -S --noconfirm git 2>/dev/null
  fi
fi
command -v git &>/dev/null || fatal "Git is required. Install it and re-run."
success "Git $(git --version | grep -oE '[0-9]+\.[0-9]+\.[0-9]+')"

# ── Clone or update Talome ──────────────────────────────────────────────────
step "Installing Talome"

mkdir -p "${TALOME_DIR}"

if [ -d "${INSTALL_DIR}/.git" ]; then
  info "Existing installation found, updating..."
  cd "${INSTALL_DIR}"
  git pull --ff-only origin main 2>/dev/null || warn "Could not pull latest — using existing version"
else
  info "Cloning Talome..."
  git clone --depth 1 "${TALOME_REPO}" "${INSTALL_DIR}"
  cd "${INSTALL_DIR}"
fi

success "Source ready"

# ── Install dependencies ─────────────────────────────────────────────────────
step "Installing dependencies"

info "This may take a minute on first install..."
cd "${INSTALL_DIR}"
pnpm install --frozen-lockfile 2>/dev/null || pnpm install
success "Dependencies installed"

# ── Build ────────────────────────────────────────────────────────────────────
step "Building"

pnpm build
success "Build complete"

# ── Generate secret key (first run only) ─────────────────────────────────────
step "Configuring"

ENV_FILE="${INSTALL_DIR}/apps/core/.env"
if [ ! -f "${ENV_FILE}" ]; then
  TALOME_SECRET=$(openssl rand -hex 32)
  cat > "${ENV_FILE}" << EOF
TALOME_SECRET=${TALOME_SECRET}
DATABASE_PATH=${TALOME_DIR}/data/talome.db
EOF
  chmod 600 "${ENV_FILE}"
  mkdir -p "${TALOME_DIR}/data"
  success "Generated encryption key"
else
  success "Existing config found"
fi

# ── Set up auto-start ────────────────────────────────────────────────────────
step "Setting up service"

if [ "${OS}" = "Linux" ] && command -v systemctl &>/dev/null; then
  # systemd service
  SERVICE_FILE="/etc/systemd/system/talome.service"
  if [ ! -f "${SERVICE_FILE}" ]; then
    sudo tee "${SERVICE_FILE}" > /dev/null << EOF
[Unit]
Description=Talome — AI Home Server
After=network.target docker.service
Wants=docker.service

[Service]
Type=simple
User=${USER}
WorkingDirectory=${INSTALL_DIR}
ExecStart=$(which node) ${INSTALL_DIR}/scripts/supervisor.js
Restart=on-failure
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF
    sudo systemctl daemon-reload
    sudo systemctl enable talome
    success "Created systemd service"
  else
    success "Systemd service already exists"
  fi
  info "Starting Talome..."
  sudo systemctl start talome

elif [ "${OS}" = "Darwin" ]; then
  # macOS launchd
  PLIST_FILE="${HOME}/Library/LaunchAgents/dev.talome.plist"
  if [ ! -f "${PLIST_FILE}" ]; then
    mkdir -p "${HOME}/Library/LaunchAgents"
    cat > "${PLIST_FILE}" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>dev.talome</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(which node)</string>
    <string>${INSTALL_DIR}/scripts/supervisor.js</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${INSTALL_DIR}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>EnvironmentVariables</key>
  <dict>
    <key>NODE_ENV</key>
    <string>production</string>
    <key>PATH</key>
    <string>${TALOME_DIR}/node/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
  <key>StandardOutPath</key>
  <string>${TALOME_DIR}/logs/talome.log</string>
  <key>StandardErrorPath</key>
  <string>${TALOME_DIR}/logs/talome.error.log</string>
</dict>
</plist>
EOF
    mkdir -p "${TALOME_DIR}/logs"
    success "Created launchd service (auto-starts on login)"
  else
    success "Launchd service already exists"
  fi
  info "Starting Talome..."
  launchctl bootout gui/$(id -u) "${PLIST_FILE}" 2>/dev/null || true
  launchctl bootstrap gui/$(id -u) "${PLIST_FILE}"

else
  warn "Auto-start not configured. Start manually: cd ${INSTALL_DIR} && node scripts/supervisor.js"
fi

# ── Wait for health ───────────────────────────────────────────────────────────
info "Waiting for services to be ready..."
HEALTH_URL="http://localhost:${API_PORT}/api/health"
MAX_WAIT=120
WAITED=0

while true; do
  STATUS=$(curl -s -o /dev/null -w "%{http_code}" "${HEALTH_URL}" 2>/dev/null || echo "000")
  if [ "${STATUS}" = "200" ] || [ "${STATUS}" = "503" ]; then
    break
  fi
  i=$(( WAITED / 2 % 10 ))
  printf "\r  ${CYAN}${SPINNER:$i:1}${RESET} Starting...  " >&2
  sleep 2
  WAITED=$((WAITED+2))
  if [ $WAITED -ge $MAX_WAIT ]; then
    printf "\r                    \r" >&2
    warn "Talome is taking longer than expected."
    if [ "${OS}" = "Linux" ]; then
      warn "Check: sudo journalctl -u talome -f"
    else
      warn "Check: tail -f ${TALOME_DIR}/logs/talome.log"
    fi
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
echo -e "  ${DIM}Install dir${RESET}   ${INSTALL_DIR}"
echo -e "  ${DIM}Data${RESET}          ${TALOME_DIR}/data"
if [ "${OS}" = "Linux" ]; then
  echo -e "  ${DIM}Logs${RESET}          sudo journalctl -u talome -f"
  echo -e "  ${DIM}Restart${RESET}       sudo systemctl restart talome"
  echo -e "  ${DIM}Stop${RESET}          sudo systemctl stop talome"
else
  echo -e "  ${DIM}Logs${RESET}          tail -f ${TALOME_DIR}/logs/talome.log"
  echo -e "  ${DIM}Restart${RESET}       launchctl kickstart -k gui/$(id -u)/dev.talome"
  echo -e "  ${DIM}Stop${RESET}          launchctl bootout gui/$(id -u)/dev.talome"
fi
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
