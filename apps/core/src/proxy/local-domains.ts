/**
 * Unified orchestrator for local domain access.
 *
 * One function to enable everything: CoreDNS (wildcard DNS) + Caddy (reverse proxy)
 * + Avahi (single-hostname mDNS for server discovery).
 */

import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir, platform } from "node:os";
import { db, schema } from "../db/index.js";
import { sql } from "drizzle-orm";
import { getSetting, setSetting } from "../utils/settings.js";
import { docker, isOrbStack } from "../docker/client.js";
import { getServerLanIp } from "./ip.js";
import { ensureDnsRunning, stopDns, getDnsStatus, startIpMonitor } from "./dns.js";
import { ensureCaddyRunning, writeCaddyfileAndReload, getCaddyStatus } from "./caddy.js";
import { connectContainerToProxyNetwork } from "./network.js";
import { ensureAvahiRunning, stopAvahi, getAvahiStatus } from "./mdns.js";

/* ── Proxy route creation for all apps ─────────────────────────────────────── */

async function createProxyRoutesForApps(baseDomain: string, tlsMode: string): Promise<string[]> {
  const existingRoutes = db.all(sql`SELECT app_id FROM proxy_routes WHERE app_id IS NOT NULL`) as { app_id: string }[];
  const existingAppIds = new Set(existingRoutes.map((r) => r.app_id));

  const appPorts = new Map<string, number>();

  // 1. Talome-installed apps from DB
  const dbApps = db.all(sql`
    SELECT ia.app_id, ac.web_port
    FROM installed_apps ia
    LEFT JOIN app_catalog ac ON ia.app_id = ac.app_id AND ia.store_source_id = ac.store_source_id
    WHERE ac.web_port IS NOT NULL
  `) as { app_id: string; web_port: number }[];
  for (const app of dbApps) {
    appPorts.set(app.app_id, app.web_port);
  }

  // 2. All running Docker containers with exposed TCP ports
  const skip = new Set(["talome-caddy", "talome-avahi", "talome-tailscale", "talome-dns"]);
  try {
    const containers = await docker.listContainers({ all: false });
    for (const c of containers) {
      const name = (c.Names?.[0] ?? "").replace(/^\//, "");
      if (!name || skip.has(name)) continue;
      if (appPorts.has(name)) continue;
      const tcpPort = c.Ports?.find((p) => p.Type === "tcp" && p.PublicPort);
      if (tcpPort) {
        appPorts.set(name, tcpPort.PrivatePort);
      }
    }
  } catch {
    // Docker not available
  }

  const created: string[] = [];
  const now = new Date().toISOString();

  // Ensure home.talome.local routes to the Talome dashboard
  // (bare talome.local doesn't work in Safari due to mDNS priority for .local TLD)
  const homeDomain = `home.${baseDomain}`;
  const hasTalomeRoute = existingAppIds.has("__talome__");
  if (!hasTalomeRoute) {
    const serverIp = getServerLanIp();
    const id = randomUUID();
    db.run(sql`INSERT INTO proxy_routes (id, app_id, domain, upstream, tls_mode, created_at) VALUES (${id}, '__talome__', ${homeDomain}, ${'http://' + serverIp + ':3000'}, ${tlsMode}, ${now})`);
    created.push(homeDomain);
  } else {
    // Always update domain in case it changed (e.g. from bare domain to home.*)
    const serverIp = getServerLanIp();
    db.run(sql`UPDATE proxy_routes SET domain = ${homeDomain}, upstream = ${'http://' + serverIp + ':3000'} WHERE app_id = '__talome__'`);
  }

  for (const [appId, port] of appPorts) {
    if (existingAppIds.has(appId)) continue;

    const domain = `${appId}.${baseDomain}`;
    const upstream = `http://${appId}:${port}`;
    const id = randomUUID();

    db.run(sql`INSERT INTO proxy_routes (id, app_id, domain, upstream, tls_mode, created_at) VALUES (${id}, ${appId}, ${domain}, ${upstream}, ${tlsMode}, ${now})`);

    try {
      await connectContainerToProxyNetwork(appId);
    } catch {
      // Non-fatal — container might use host networking
    }

    created.push(domain);
  }

  if (created.length > 0) {
    await writeCaddyfileAndReload();
  }

  return created;
}

/* ── Input validation ──────────────────────────────────────────────────────── */

/** Only allow safe domain names: lowercase alphanumeric, dots, hyphens. */
function validateDomain(domain: string): boolean {
  return /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(domain) && domain.length <= 253;
}

/** Only allow valid IPv4 addresses. */
function validateIp(ip: string): boolean {
  return /^(\d{1,3}\.){3}\d{1,3}$/.test(ip) && ip.split(".").every((n) => Number(n) <= 255);
}

/* ── Server self-setup (configure this machine as a client) ────────────────── */

async function setupServerAsClient(domain: string, serverIp: string): Promise<{ dns: boolean; cert: boolean; errors: string[] }> {
  const errors: string[] = [];
  let dnsOk = false;
  let certOk = false;
  const os = platform();

  if (!validateDomain(domain)) {
    return { dns: false, cert: false, errors: ["DNS: invalid domain name"] };
  }
  if (!validateIp(serverIp)) {
    return { dns: false, cert: false, errors: ["DNS: invalid server IP"] };
  }

  // 1. DNS resolver setup
  if (os === "darwin") {
    // macOS: /etc/resolver/<domain>
    try {
      const resolverDir = "/etc/resolver";
      const resolverFile = join(resolverDir, domain);
      const content = `nameserver ${serverIp}\n`;

      // Check if already configured correctly
      if (existsSync(resolverFile) && readFileSync(resolverFile, "utf-8").trim() === content.trim()) {
        dnsOk = true;
      } else {
        mkdirSync(resolverDir, { recursive: true });
        writeFileSync(resolverFile, content);
        dnsOk = true;
        console.log(`[local-domains] Created ${resolverFile}`);
      }
    } catch {
      // Might need sudo — try with sudo
      try {
        execFileSync("sudo", ["-n", "mkdir", "-p", "/etc/resolver"], { stdio: "pipe", timeout: 5000 });
        execFileSync("sudo", ["-n", "tee", join("/etc/resolver", domain)], {
          input: `nameserver ${serverIp}\n`,
          stdio: ["pipe", "pipe", "pipe"],
          timeout: 5000,
        });
        dnsOk = true;
        console.log(`[local-domains] Created /etc/resolver/${domain} (sudo)`);
      } catch {
        errors.push("DNS: could not create /etc/resolver file (needs sudo)");
      }
    }
  } else if (os === "linux") {
    // Linux: systemd-resolved drop-in
    try {
      const confDir = "/etc/systemd/resolved.conf.d";
      const confFile = join(confDir, "talome.conf");
      const content = `[Resolve]\nDNS=${serverIp}\nDomains=~${domain}\n`;

      if (existsSync(confFile) && readFileSync(confFile, "utf-8").trim() === content.trim()) {
        dnsOk = true;
      } else {
        try {
          mkdirSync(confDir, { recursive: true });
          writeFileSync(confFile, content);
          execFileSync("systemctl", ["restart", "systemd-resolved"], { stdio: "pipe", timeout: 10000 });
          dnsOk = true;
        } catch {
          // Try with sudo
          try {
            execFileSync("sudo", ["-n", "mkdir", "-p", confDir], { stdio: "pipe", timeout: 10000 });
            execFileSync("sudo", ["-n", "tee", confFile], {
              input: content,
              stdio: ["pipe", "pipe", "pipe"],
              timeout: 10000,
            });
            execFileSync("sudo", ["-n", "systemctl", "restart", "systemd-resolved"], { stdio: "pipe", timeout: 10000 });
            dnsOk = true;
          } catch {
            errors.push("DNS: could not configure systemd-resolved (needs sudo)");
          }
        }
      }
    } catch {
      errors.push("DNS: failed to set up resolver");
    }
  }

  // 2. Trust the CA certificate
  const caCertPath = join(homedir(), ".talome", "caddy", "data", "caddy", "pki", "authorities", "local", "root.crt");
  if (existsSync(caCertPath)) {
    if (os === "darwin") {
      try {
        // Check if already trusted
        let result = "";
        try {
          result = execFileSync("security", ["find-certificate", "-c", "Caddy Local Authority", "/Library/Keychains/System.keychain"], {
            encoding: "utf-8",
            timeout: 5000,
          });
        } catch { /* not found */ }
        if (result.includes("Caddy Local Authority")) {
          certOk = true;
        } else {
          execFileSync("sudo", ["-n", "security", "add-trusted-cert", "-d", "-r", "trustRoot", "-k", "/Library/Keychains/System.keychain", caCertPath], {
            stdio: "pipe",
            timeout: 10000,
          });
          certOk = true;
          console.log("[local-domains] CA certificate trusted in System keychain");
        }
      } catch {
        errors.push("Cert: could not trust CA certificate (needs sudo)");
      }
    } else if (os === "linux") {
      try {
        const destCert = "/usr/local/share/ca-certificates/talome-ca.crt";
        try {
          execFileSync("cp", [caCertPath, destCert], { stdio: "pipe", timeout: 10000 });
          execFileSync("update-ca-certificates", [], { stdio: "pipe", timeout: 10000 });
          certOk = true;
        } catch {
          execFileSync("sudo", ["-n", "cp", caCertPath, destCert], { stdio: "pipe", timeout: 10000 });
          execFileSync("sudo", ["-n", "update-ca-certificates"], { stdio: "pipe", timeout: 10000 });
          certOk = true;
        }
        console.log("[local-domains] CA certificate trusted");
      } catch {
        errors.push("Cert: could not trust CA certificate (needs sudo)");
      }
    }
  }

  return { dns: dnsOk, cert: certOk, errors };
}

/* ── Enable / Disable / Status ─────────────────────────────────────────────── */

let stopMonitor: (() => void) | null = null;

export async function enableLocalDomains(baseDomain?: string): Promise<{
  ok: boolean;
  ip: string;
  domain: string;
  proxyRoutes: string[];
  serverSetup?: { dns: boolean; cert: boolean; errors: string[] };
  error?: string;
}> {
  const domain = baseDomain || "talome.local";
  const ip = getServerLanIp();

  if (!validateDomain(domain)) {
    return { ok: false, ip, domain, proxyRoutes: [], error: "Invalid domain name — only lowercase alphanumeric, dots, and hyphens allowed" };
  }

  // 1. Save settings
  setSetting("local_domains_enabled", "true");
  setSetting("local_domains_base", domain);
  setSetting("proxy_enabled", "true");
  setSetting("proxy_base_domain", domain);
  setSetting("proxy_default_tls", "selfsigned");

  const orbstack = isOrbStack();

  // 2. Start CoreDNS (wildcard zone — handles all subdomains instantly)
  // Skip on OrbStack — it provides built-in *.orb.local DNS resolution
  if (orbstack) {
    console.log("[local-domains] OrbStack detected — skipping CoreDNS (OrbStack provides *.orb.local DNS)");
  } else {
    const dnsResult = await ensureDnsRunning(domain, ip);
    if (!dnsResult.ok) {
      return { ok: false, ip, domain, proxyRoutes: [], error: `DNS: ${dnsResult.error}` };
    }
  }

  // 3. Start Caddy + create proxy routes (always needed, even on OrbStack)
  const caddyResult = await ensureCaddyRunning();
  if (!caddyResult.ok) {
    return { ok: false, ip, domain, proxyRoutes: [], error: `Proxy: ${caddyResult.error}` };
  }

  const proxyRoutes = await createProxyRoutesForApps(domain, "selfsigned");

  // 4. Start simplified Avahi (single hostname for server discovery)
  // Skip on OrbStack — it provides built-in mDNS for container discovery
  if (orbstack) {
    console.log("[local-domains] OrbStack detected — skipping Avahi (OrbStack provides mDNS)");
  } else {
    await ensureAvahiRunning(domain, ip);
  }

  // 5. Start IP change monitor
  if (stopMonitor) stopMonitor();
  stopMonitor = startIpMonitor(domain);

  // 6. Auto-configure this server machine as a client (DNS resolver + cert trust)
  const serverSetup = await setupServerAsClient(domain, ip);
  if (serverSetup.errors.length > 0) {
    console.log(`[local-domains] Server self-setup partial: ${serverSetup.errors.join("; ")}`);
  }

  return { ok: true, ip, domain, proxyRoutes, serverSetup };
}

export async function disableLocalDomains(): Promise<void> {
  setSetting("local_domains_enabled", "false");

  if (stopMonitor) {
    stopMonitor();
    stopMonitor = null;
  }

  await stopDns();
  await stopAvahi();
}

export async function getLocalDomainsStatus(): Promise<{
  enabled: boolean;
  baseDomain: string;
  serverIp: string;
  dns: { running: boolean };
  proxy: { running: boolean; routeCount: number };
  mdns: { running: boolean };
  caCertAvailable: boolean;
  serverConfigured: boolean;
}> {
  const enabled = getSetting("local_domains_enabled") === "true";
  const baseDomain = getSetting("local_domains_base") || "talome.local";
  const serverIp = getServerLanIp();

  const [dnsStatus, proxyStatus, mdnsStatus] = await Promise.all([
    getDnsStatus(),
    getCaddyStatus(),
    getAvahiStatus(),
  ]);

  // Check if Caddy CA cert exists
  const caCertPath = join(homedir(), ".talome", "caddy", "data", "caddy", "pki", "authorities", "local", "root.crt");
  const caCertAvailable = existsSync(caCertPath);

  // Check if this server machine is configured as a client
  let serverConfigured = false;
  const os = platform();
  if (os === "darwin") {
    const resolverFile = join("/etc/resolver", baseDomain);
    serverConfigured = existsSync(resolverFile);
  } else if (os === "linux") {
    serverConfigured = existsSync("/etc/systemd/resolved.conf.d/talome.conf");
  }

  return {
    enabled,
    baseDomain,
    serverIp,
    dns: { running: dnsStatus.running },
    proxy: { running: proxyStatus.running, routeCount: proxyStatus.routeCount },
    mdns: { running: mdnsStatus.running },
    caCertAvailable,
    serverConfigured,
  };
}

export { createProxyRoutesForApps };
