#Requires -Version 5.1
Set-StrictMode -Version Latest

# ─────────────────────────────────────────────────────────────────────────────
#  Talome — Windows installer
#
#  Native Windows installation is not supported in v0.1.
#  Talome's self-evolution requires systemd/launchd-style service management
#  and a writable source tree; the current PowerShell installer only knew how
#  to run the Docker image, which disables self-evolution.
#
#  If you want to run Talome on Windows today, use WSL2:
#
#      wsl --install -d Ubuntu-22.04
#      wsl -d Ubuntu-22.04
#      curl -fsSL https://get.talome.dev | bash
#
#  A proper Windows installer (Windows Service + self-evolution-safe) is on
#  the roadmap. Track progress at https://github.com/tomastruben/Talome/issues.
# ─────────────────────────────────────────────────────────────────────────────

Write-Host ""
Write-Host "  Talome on Windows" -ForegroundColor Cyan
Write-Host ("  " + ("-" * 18)) -ForegroundColor DarkGray
Write-Host ""
Write-Host "  Native Windows install is not supported in this release." -ForegroundColor Yellow
Write-Host ""
Write-Host "  Recommended path - WSL2:"
Write-Host ""
Write-Host "    wsl --install -d Ubuntu-22.04" -ForegroundColor Green
Write-Host "    wsl -d Ubuntu-22.04" -ForegroundColor Green
Write-Host "    curl -fsSL https://get.talome.dev | bash" -ForegroundColor Green
Write-Host ""
Write-Host "  Track progress on native Windows support:"
Write-Host "    https://github.com/tomastruben/Talome/issues" -ForegroundColor Cyan
Write-Host ""

exit 1
