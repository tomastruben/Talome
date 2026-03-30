#Requires -Version 5.1
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# ── Colours ──────────────────────────────────────────────────────────────────
function Write-Info  ($msg) { Write-Host "  → $msg" -ForegroundColor Cyan }
function Write-Ok    ($msg) { Write-Host "  ✓ $msg" -ForegroundColor Green }
function Write-Warn  ($msg) { Write-Host "  ! $msg" -ForegroundColor Yellow }
function Write-Fail  ($msg) { Write-Host "  ✗ $msg" -ForegroundColor Red; exit 1 }

$TalomeDir = "$env:USERPROFILE\.talome"
$TalomeImage = "ghcr.io/tomastruben/talome:latest"
$ApiPort = if ($env:TALOME_API_PORT) { $env:TALOME_API_PORT } else { "4000" }
$DashboardPort = if ($env:TALOME_DASHBOARD_PORT) { $env:TALOME_DASHBOARD_PORT } else { "3000" }

# ── Update subcommand ────────────────────────────────────────────────────────
if ($args -contains "update") {
    Write-Host ""
    Write-Host "  Updating Talome..." -ForegroundColor White
    Write-Host ""
    Write-Info "Pulling latest image..."
    docker pull $TalomeImage
    if ($LASTEXITCODE -ne 0) { Write-Fail "Failed to pull latest image." }
    Push-Location $TalomeDir
    Write-Info "Restarting containers..."
    docker compose up -d
    if ($LASTEXITCODE -ne 0) { Write-Fail "Failed to restart Talome after update." }
    Pop-Location
    Write-Host ""
    Write-Ok "Talome updated successfully!"
    Write-Host ""
    Write-Host "  Dashboard  " -NoNewline; Write-Host "http://localhost:$DashboardPort" -ForegroundColor Cyan
    Write-Host ""
    exit 0
}

# ── Header ───────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host @"
        ████████╗ █████╗ ██╗      ██████╗ ███╗   ███╗███████╗
        ╚══██╔══╝██╔══██╗██║     ██╔═══██╗████╗ ████║██╔════╝
           ██║   ███████║██║     ██║   ██║██╔████╔██║█████╗
           ██║   ██╔══██║██║     ██║   ██║██║╚██╔╝██║██╔══╝
           ██║   ██║  ██║███████╗╚██████╔╝██║ ╚═╝ ██║███████╗
           ╚═╝   ╚═╝  ╚═╝╚══════╝ ╚═════╝ ╚═╝     ╚═╝╚══════╝
"@ -ForegroundColor Cyan
Write-Host ""
Write-Host "        The self-evolving home server  ·  v0.1.0 public alpha" -ForegroundColor DarkGray
Write-Host ""

# ── System detection ─────────────────────────────────────────────────────────
Write-Host ""
Write-Host "  Detecting system" -ForegroundColor White
Write-Host "  ────────────────" -ForegroundColor DarkGray

$osVersion = [System.Environment]::OSVersion.Version
$osName = "Windows $($osVersion.Major).$($osVersion.Minor).$($osVersion.Build)"
$arch = if ([Environment]::Is64BitOperatingSystem) { "x86_64 (amd64)" } else { "x86 (32-bit)" }
if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") { $arch = "ARM64" }

$mem = [math]::Round((Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory / 1GB)
$disk = [math]::Round((Get-PSDrive C).Free / 1GB)

Write-Ok "OS:      $osName"
Write-Ok "Arch:    $arch"
Write-Ok "Memory:  $mem GB"
Write-Ok "Disk:    $disk GB free (C:)"

if ($mem -lt 2) {
    Write-Warn "Talome recommends at least 2 GB of RAM (found $mem GB)"
}

# ── Port check ───────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "  Checking ports" -ForegroundColor White
Write-Host "  ──────────────" -ForegroundColor DarkGray

function Test-Port ($port, $name) {
    $listener = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
    if ($listener) {
        Write-Fail "Port $port ($name) is in use. Set TALOME_$($name)_PORT to change it."
    }
}

Test-Port $ApiPort "API"
Test-Port $DashboardPort "DASHBOARD"
Write-Ok "Port $ApiPort (API) available"
Write-Ok "Port $DashboardPort (Dashboard) available"

# ── Docker check / install ───────────────────────────────────────────────────
Write-Host ""
Write-Host "  Checking Docker" -ForegroundColor White
Write-Host "  ───────────────" -ForegroundColor DarkGray

$hasDocker = Get-Command docker -ErrorAction SilentlyContinue

if (-not $hasDocker) {
    Write-Info "Docker not found. Installing Docker Desktop..."

    # Check WSL2
    $wslStatus = wsl --status 2>&1
    if ($LASTEXITCODE -ne 0) {
        Write-Info "Installing WSL2 (required by Docker Desktop)..."
        wsl --install --no-distribution
        Write-Warn "WSL2 installed. A restart may be required."
        Write-Warn "After restart, re-run this installer."
        Read-Host "  Press Enter to continue"
    }

    # Download Docker Desktop
    $dockerUrl = "https://desktop.docker.com/win/main/amd64/Docker%20Desktop%20Installer.exe"
    $installerPath = "$env:TEMP\DockerDesktopInstaller.exe"

    Write-Info "Downloading Docker Desktop..."
    Invoke-WebRequest -Uri $dockerUrl -OutFile $installerPath -UseBasicParsing

    Write-Info "Installing Docker Desktop (this may take a minute)..."
    Start-Process -FilePath $installerPath -ArgumentList "install", "--quiet", "--accept-license" -Wait
    Remove-Item $installerPath -ErrorAction SilentlyContinue

    # Refresh PATH
    $env:PATH = [System.Environment]::GetEnvironmentVariable("PATH", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("PATH", "User")

    if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
        Write-Warn "Docker Desktop installed but not yet in PATH."
        Write-Warn "Start Docker Desktop, then re-run this installer."
        exit 1
    }
    Write-Ok "Docker Desktop installed"
} else {
    $dockerVer = (docker --version) -replace "Docker version ([0-9.]+).*", '$1'
    Write-Ok "Docker $dockerVer (Docker Desktop)"
}

# ── Docker daemon running? ───────────────────────────────────────────────────
$dockerRunning = docker info 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Info "Starting Docker Desktop..."
    Start-Process "C:\Program Files\Docker\Docker\Docker Desktop.exe" -ErrorAction SilentlyContinue
    Write-Info "Waiting for Docker to start..."
    $waited = 0
    while ($waited -lt 90) {
        Start-Sleep -Seconds 2
        $waited += 2
        docker info 2>&1 | Out-Null
        if ($LASTEXITCODE -eq 0) { break }
    }
    if ($waited -ge 90) {
        Write-Fail "Docker didn't start within 90 seconds. Start Docker Desktop manually and re-run."
    }
}
Write-Ok "Docker daemon is running"

# ── Create Talome directory ──────────────────────────────────────────────────
Write-Host ""
Write-Host "  Setting up Talome" -ForegroundColor White
Write-Host "  ─────────────────" -ForegroundColor DarkGray

if (-not (Test-Path $TalomeDir)) { New-Item -ItemType Directory -Path $TalomeDir -Force | Out-Null }
Write-Ok "Config directory: $TalomeDir"

# ── Generate secret key ─────────────────────────────────────────────────────
$envFile = Join-Path $TalomeDir ".env"
if (-not (Test-Path $envFile)) {
    $secret = -join ((1..32) | ForEach-Object { "{0:x2}" -f (Get-Random -Maximum 256) })
    "TALOME_SECRET=$secret" | Set-Content -Path $envFile
    Write-Ok "Generated encryption key"
} else {
    Write-Ok "Existing config found"
}

# ── Write docker-compose.yml ────────────────────────────────────────────────
$composeFile = Join-Path $TalomeDir "docker-compose.yml"
if (-not (Test-Path $composeFile)) {
    @"
services:
  talome:
    image: $TalomeImage
    container_name: talome
    restart: unless-stopped
    ports:
      - "${ApiPort}:4000"
      - "${DashboardPort}:3000"
    volumes:
      - talome-data:/app/data
      - /var/run/docker.sock:/var/run/docker.sock
    env_file:
      - .env
    environment:
      - NODE_ENV=production

volumes:
  talome-data:
"@ | Set-Content -Path $composeFile
    Write-Ok "Created docker-compose.yml"
} else {
    Write-Ok "Existing docker-compose.yml found"
}

# ── Pull image ───────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "  Pulling Talome" -ForegroundColor White
Write-Host "  ──────────────" -ForegroundColor DarkGray

Write-Info "Downloading $TalomeImage"
docker pull $TalomeImage
if ($LASTEXITCODE -ne 0) { Write-Fail "Failed to pull image. Check your internet connection." }
Write-Ok "Image ready"

# ── Start containers ─────────────────────────────────────────────────────────
Write-Host ""
Write-Host "  Starting Talome" -ForegroundColor White
Write-Host "  ───────────────" -ForegroundColor DarkGray

Push-Location $TalomeDir
docker compose up -d
if ($LASTEXITCODE -ne 0) { Write-Fail "Failed to start. Check 'docker compose logs' in $TalomeDir" }
Pop-Location

# ── Wait for health ──────────────────────────────────────────────────────────
Write-Info "Waiting for services to be ready..."
$healthUrl = "http://localhost:$ApiPort/api/health"
$waited = 0

while ($waited -lt 120) {
    try {
        $response = Invoke-WebRequest -Uri $healthUrl -UseBasicParsing -TimeoutSec 2 -ErrorAction SilentlyContinue
        if ($response.StatusCode -eq 200 -or $response.StatusCode -eq 503) { break }
    } catch {}
    Start-Sleep -Seconds 2
    $waited += 2
}

if ($waited -ge 120) {
    Write-Warn "Talome is taking longer than expected. Check: docker logs talome"
}

Write-Ok "Talome is running!"

# ── Done ─────────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor Green
Write-Host ""
Write-Host "  Open Talome   " -NoNewline -ForegroundColor White
Write-Host "http://localhost:$DashboardPort" -ForegroundColor Cyan
Write-Host ""
Write-Host "  Config        $TalomeDir" -ForegroundColor DarkGray
Write-Host "  Logs          docker logs -f talome" -ForegroundColor DarkGray
Write-Host "  Stop          cd $TalomeDir; docker compose down" -ForegroundColor DarkGray
Write-Host "  Update        irm https://get.talome.dev/install.ps1 | iex -- update" -ForegroundColor DarkGray
Write-Host ""
Write-Host "  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor Green
Write-Host ""

# Open browser
Start-Process "http://localhost:$DashboardPort"
