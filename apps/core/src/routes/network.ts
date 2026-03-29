import { Hono } from "hono";
import { z } from "zod";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  enableLocalDomains,
  disableLocalDomains,
  getLocalDomainsStatus,
} from "../proxy/local-domains.js";
import { getServerLanIp } from "../proxy/ip.js";

export const network = new Hono();

// Unified status
network.get("/status", async (c) => {
  const status = await getLocalDomainsStatus();
  return c.json(status);
});

// Enable local domains
const enableSchema = z.object({
  baseDomain: z.string().min(1).default("talome.local"),
});

network.post("/enable", async (c) => {
  const body = enableSchema.safeParse(await c.req.json());
  if (!body.success) return c.json({ error: body.error.flatten() }, 400);

  const result = await enableLocalDomains(body.data.baseDomain);
  if (!result.ok) return c.json({ error: result.error }, 500);

  return c.json({
    ok: true,
    ip: result.ip,
    domain: result.domain,
    proxyRoutes: result.proxyRoutes,
    setupCommand: `curl -fsSL http://${result.ip}:4000/api/network/setup.sh | sudo bash`,
  });
});

// Disable local domains
network.post("/disable", async (c) => {
  await disableLocalDomains();
  return c.json({ ok: true });
});

// Serve CA certificate
network.get("/ca.pem", async (c) => {
  const certPath = join(homedir(), ".talome", "caddy", "data", "caddy", "pki", "authorities", "local", "root.crt");
  if (!existsSync(certPath)) {
    return c.json({ error: "CA certificate not yet generated. Enable local domains first." }, 404);
  }
  const cert = readFileSync(certPath, "utf-8");
  return c.text(cert, 200, { "Content-Type": "application/x-pem-file", "Content-Disposition": "attachment; filename=talome-ca.pem" });
});

// Mobile / browser setup guide (no auth required)
network.get("/setup", async (c) => {
  const serverIp = getServerLanIp();
  const status = await getLocalDomainsStatus();
  const domain = status.baseDomain;
  const certPath = join(homedir(), ".talome", "caddy", "data", "caddy", "pki", "authorities", "local", "root.crt");
  const certAvailable = existsSync(certPath);

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Talome — Device Setup</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; background: #1a1a1a; color: #e5e5e5; padding: 24px; line-height: 1.6; }
    h1 { font-size: 20px; font-weight: 600; margin-bottom: 4px; }
    .subtitle { color: #999; font-size: 14px; margin-bottom: 32px; }
    .section { background: #252525; border-radius: 12px; padding: 20px; margin-bottom: 16px; }
    .section h2 { font-size: 15px; font-weight: 600; margin-bottom: 12px; display: flex; align-items: center; gap: 8px; }
    .step { font-size: 14px; color: #ccc; margin-bottom: 8px; padding-left: 24px; position: relative; }
    .step::before { content: attr(data-n); position: absolute; left: 0; color: #666; font-weight: 600; font-size: 13px; }
    .mono { font-family: "SF Mono", "Fira Code", monospace; background: #333; padding: 2px 6px; border-radius: 4px; font-size: 13px; color: #fff; }
    .btn { display: inline-block; background: #fff; color: #1a1a1a; padding: 10px 20px; border-radius: 8px; text-decoration: none; font-weight: 600; font-size: 14px; margin-top: 8px; }
    .btn:active { opacity: 0.8; }
    .note { font-size: 13px; color: #888; margin-top: 12px; line-height: 1.5; }
    .badge { display: inline-block; background: #2d5a2d; color: #6fcf6f; font-size: 12px; padding: 2px 8px; border-radius: 4px; font-weight: 500; }
    .badge.off { background: #5a2d2d; color: #cf6f6f; }
    .divider { height: 1px; background: #333; margin: 16px 0; }
    .info-row { display: flex; justify-content: space-between; align-items: center; font-size: 14px; padding: 4px 0; }
    .info-label { color: #888; }
    .info-value { font-family: "SF Mono", monospace; font-size: 13px; }
  </style>
</head>
<body>
  <h1>Talome Device Setup</h1>
  <p class="subtitle">One-time setup to access your server from this device</p>

  <div class="section">
    <div class="info-row">
      <span class="info-label">Dashboard</span>
      <span class="info-value">home.${domain}</span>
    </div>
    <div class="info-row">
      <span class="info-label">Apps</span>
      <span class="info-value">appname.${domain}</span>
    </div>
    <div class="info-row">
      <span class="info-label">Server</span>
      <span class="info-value">${serverIp}</span>
    </div>
  </div>

  <div class="section">
    <h2><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:inline;vertical-align:middle"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.55a11 11 0 0 1 14.08 0"/><path d="M1.42 9a16 16 0 0 1 21.16 0"/><path d="M8.53 16.11a6 6 0 0 1 6.95 0"/><circle cx="12" cy="20" r="1"/></svg></svg> Step 1 &mdash; Set DNS Server</h2>
    <p style="font-size: 14px; color: #ccc; margin-bottom: 12px;">Point your device's DNS to your Talome server.</p>
    <div class="step" data-n="1.">Open <strong>Settings &rarr; Wi-Fi</strong></div>
    <div class="step" data-n="2.">Tap the <strong>&#9432;</strong> next to your network</div>
    <div class="step" data-n="3."><strong>iOS:</strong> Configure DNS &rarr; Manual &nbsp;|&nbsp; <strong>Android:</strong> IP settings &rarr; Static</div>
    <div class="step" data-n="4.">Set DNS to: <span class="mono">${serverIp}</span></div>
    <div class="step" data-n="5.">Save</div>
    <p class="note">Non-Talome domains are forwarded to Cloudflare and Google automatically.</p>
  </div>

  <div class="section">
    <h2><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:inline;vertical-align:middle"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg> Step 2 &mdash; Trust Certificate</h2>
    ${certAvailable ? `
    <p style="font-size: 14px; color: #ccc; margin-bottom: 12px;">Install the Talome certificate so <strong>home.${domain}</strong> and all your apps load without warnings.</p>
    <div style="display: flex; gap: 10px; flex-wrap: wrap;">
      <a class="btn" href="http://${serverIp}:4000/api/network/setup.mobileconfig">Install Profile (Apple)</a>
      <a class="btn" href="http://${serverIp}:4000/api/network/ca.pem" style="background: #333; color: #fff;">Download Certificate</a>
    </div>
    <div class="divider"></div>
    <p class="step" data-n=""><strong>Apple:</strong> Tap Install Profile &rarr; Settings &rarr; General &rarr; VPN & Device Management &rarr; Install. Then Settings &rarr; General &rarr; About &rarr; Certificate Trust Settings &rarr; enable Talome CA.</p>
    <p class="step" data-n=""><strong>Android:</strong> Tap Download Certificate &rarr; open the file &rarr; name it "Talome" &rarr; OK.</p>
    <p class="step" data-n=""><strong>macOS:</strong> Tap Install Profile &rarr; open the downloaded file &rarr; follow prompts.</p>
    <p class="note">You can remove the profile or certificate anytime from Settings.</p>
    ` : `
    <p class="note">Certificate not yet generated. Enable local domains first, then revisit this page.</p>
    `}
  </div>

  <div class="section">
    <h2><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:inline;vertical-align:middle"><path d="M20 6L9 17l-5-5"/></svg> Verify</h2>
    <p style="font-size: 14px; color: #ccc;">Open your browser and visit your dashboard:</p>
    <p style="margin-top: 8px;"><a href="https://home.${domain}" style="color: #6fb3ff; font-family: monospace; font-size: 15px; font-weight: 500;">home.${domain}</a></p>
    <p class="note">No certificate warning means everything is working. Your apps are at appname.${domain}.</p>
  </div>
</body>
</html>`;

  return c.html(html);
});

// macOS/Linux setup script
network.get("/setup.sh", async (c) => {
  const serverIp = getServerLanIp();
  const certPath = join(homedir(), ".talome", "caddy", "data", "caddy", "pki", "authorities", "local", "root.crt");
  const certExists = existsSync(certPath);
  const cert = certExists ? readFileSync(certPath, "utf-8") : "";

  // Get base domain from status
  const status = await getLocalDomainsStatus();
  const domain = status.baseDomain;

  const script = `#!/bin/bash
set -e

TALOME_IP="${serverIp}"
DOMAIN="${domain}"

echo "Talome Local Domain Setup"
echo "========================"
echo ""
echo "Server: \${TALOME_IP}"
echo "Domain: *.\${DOMAIN}"
echo ""

# Detect OS
case "$(uname -s)" in
  Darwin)
    echo "Detected: macOS"
    echo ""

    # 1. Create resolver file for .local domain routing
    echo "Setting up DNS resolver..."
    mkdir -p /etc/resolver
    cat > /etc/resolver/\${DOMAIN} <<EOF
nameserver \${TALOME_IP}
EOF
    echo "  Created /etc/resolver/\${DOMAIN}"

    # 2. Trust the HTTPS certificate
${cert ? `    echo "Installing HTTPS certificate..."
    CERT_FILE=$(mktemp /tmp/talome-ca.XXXXXX.pem)
    cat > "\${CERT_FILE}" <<'CERT_EOF'
${cert.trim()}
CERT_EOF
    security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain "\${CERT_FILE}"
    rm -f "\${CERT_FILE}"
    echo "  CA certificate trusted"` : `    echo "Note: HTTPS certificate not yet available."
    echo "  After enabling local domains, re-run this script to trust the certificate."
    echo "  Or download it manually: curl -o talome-ca.pem http://\${TALOME_IP}:4000/api/network/ca.pem"`}

    echo ""
    echo "Done! All *.\${DOMAIN} addresses now resolve to \${TALOME_IP}."
    echo "Open https://sonarr.\${DOMAIN} (or any app) in your browser to verify."
    ;;

  Linux)
    echo "Detected: Linux"
    echo ""

    # 1. Configure DNS routing
    if [ -d /etc/systemd/resolved.conf.d ] || command -v systemctl >/dev/null 2>&1; then
      echo "Setting up systemd-resolved..."
      mkdir -p /etc/systemd/resolved.conf.d
      cat > /etc/systemd/resolved.conf.d/talome.conf <<EOF
[Resolve]
DNS=\${TALOME_IP}
Domains=~\${DOMAIN}
EOF
      systemctl restart systemd-resolved 2>/dev/null || true
      echo "  Created systemd-resolved config"
    elif command -v resolvconf >/dev/null 2>&1; then
      echo "Setting up resolvconf..."
      echo "nameserver \${TALOME_IP}" > /etc/resolvconf/resolv.conf.d/tail
      resolvconf -u
      echo "  Updated resolvconf"
    else
      echo "Warning: Could not detect DNS resolver. Add the following to your DNS:"
      echo "  nameserver \${TALOME_IP} for domain \${DOMAIN}"
    fi

    # 2. Trust the HTTPS certificate
${cert ? `    echo "Installing HTTPS certificate..."
    CERT_FILE="/usr/local/share/ca-certificates/talome-ca.crt"
    cat > "\${CERT_FILE}" <<'CERT_EOF'
${cert.trim()}
CERT_EOF
    update-ca-certificates 2>/dev/null || true
    echo "  CA certificate trusted"` : `    echo "Note: HTTPS certificate not yet available."`}

    echo ""
    echo "Done! All *.\${DOMAIN} addresses now resolve to \${TALOME_IP}."
    ;;

  *)
    echo "Unsupported OS: $(uname -s)"
    echo "For Windows, use: irm http://\${TALOME_IP}:4000/api/network/setup.ps1 | iex"
    exit 1
    ;;
esac
`;

  return c.text(script, 200, { "Content-Type": "text/x-shellscript" });
});

// Apple .mobileconfig profile (macOS + iOS one-click setup)
network.get("/setup.mobileconfig", async (c) => {
  const serverIp = getServerLanIp();
  const certPath = join(homedir(), ".talome", "caddy", "data", "caddy", "pki", "authorities", "local", "root.crt");
  const certExists = existsSync(certPath);

  const status = await getLocalDomainsStatus();
  const domain = status.baseDomain;

  if (!certExists) {
    return c.json({ error: "CA certificate not yet generated. Enable local domains first." }, 404);
  }

  const certDer = readFileSync(certPath);
  const certBase64 = Buffer.from(certDer).toString("base64");

  // Deterministic UUIDs so re-installs replace cleanly
  const { createHash } = await import("node:crypto");
  const toUUID = (s: string) => {
    const h = createHash("md5").update(s).digest("hex");
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
  };
  const profileUUID = toUUID(`talome-profile-${domain}`);
  const certUUID = toUUID(`talome-cert-${domain}`);

  // Apple doesn't support plain DNS server config via profiles (only DoH/DoT).
  // This profile installs the CA certificate — the hard part for users.
  // DNS must still be set manually (Wi-Fi settings).
  const profile = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>PayloadContent</key>
  <array>
    <dict>
      <key>PayloadType</key>
      <string>com.apple.security.root</string>
      <key>PayloadVersion</key>
      <integer>1</integer>
      <key>PayloadIdentifier</key>
      <string>com.talome.cert.${domain}</string>
      <key>PayloadUUID</key>
      <string>${certUUID}</string>
      <key>PayloadDisplayName</key>
      <string>Talome CA Certificate</string>
      <key>PayloadContent</key>
      <data>${certBase64}</data>
    </dict>
  </array>
  <key>PayloadDisplayName</key>
  <string>Talome Local Access</string>
  <key>PayloadDescription</key>
  <string>Trusts the Talome HTTPS certificate so home.${domain} and all apps load without security warnings. You still need to set your DNS server to ${serverIp} in Wi-Fi settings.</string>
  <key>PayloadIdentifier</key>
  <string>com.talome.profile.${domain}</string>
  <key>PayloadUUID</key>
  <string>${profileUUID}</string>
  <key>PayloadType</key>
  <string>Configuration</string>
  <key>PayloadVersion</key>
  <integer>1</integer>
  <key>PayloadOrganization</key>
  <string>Talome</string>
  <key>PayloadRemovalDisallowed</key>
  <false/>
</dict>
</plist>`;

  return c.body(profile, 200, {
    "Content-Type": "application/x-apple-aspen-config",
    "Content-Disposition": `attachment; filename="talome-${domain}.mobileconfig"`,
  });
});

// Windows PowerShell setup script
network.get("/setup.ps1", async (c) => {
  const serverIp = getServerLanIp();
  const certPath = join(homedir(), ".talome", "caddy", "data", "caddy", "pki", "authorities", "local", "root.crt");
  const certExists = existsSync(certPath);

  const status = await getLocalDomainsStatus();
  const domain = status.baseDomain;

  const script = `# Talome Local Domain Setup (Windows)
# Run as Administrator in PowerShell

$TalomeIP = "${serverIp}"
$Domain = "${domain}"

Write-Host "Talome Local Domain Setup" -ForegroundColor Cyan
Write-Host "========================"
Write-Host ""

# 1. Add DNS client NRPT rule
Write-Host "Setting up DNS routing..."
Add-DnsClientNrptRule -Namespace ".$Domain" -NameServers $TalomeIP -ErrorAction SilentlyContinue
Write-Host "  DNS rule added for *.$Domain -> $TalomeIP"

# 2. Trust the HTTPS certificate
${certExists ? `Write-Host "Installing HTTPS certificate..."
$CertUrl = "http://$($TalomeIP):4000/api/network/ca.pem"
$CertPath = "$env:TEMP\\talome-ca.pem"
Invoke-WebRequest -Uri $CertUrl -OutFile $CertPath
Import-Certificate -FilePath $CertPath -CertStoreLocation Cert:\\LocalMachine\\Root
Remove-Item $CertPath
Write-Host "  CA certificate trusted"` : `Write-Host "Note: HTTPS certificate not yet available." -ForegroundColor Yellow`}

Write-Host ""
Write-Host "Done! All *.$Domain addresses now resolve to your server." -ForegroundColor Green
`;

  return c.text(script, 200, { "Content-Type": "text/plain" });
});
