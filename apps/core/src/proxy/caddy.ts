import { mkdirSync, readFileSync, existsSync } from "node:fs";
import { atomicWriteFileSync } from "../utils/filesystem.js";
import { join } from "node:path";
import os from "node:os";
import { db } from "../db/index.js";
import { sql } from "drizzle-orm";
import { getSetting } from "../utils/settings.js";
import { docker } from "../docker/client.js";
import { generateCaddyfile } from "./caddyfile.js";
import { ensureProxyNetwork, connectContainerToProxyNetwork, PROXY_NETWORK } from "./network.js";

const CADDY_DIR = join(os.homedir(), ".talome", "caddy");
const CADDY_CONTAINER_NAME = "talome-caddy";
const CADDY_IMAGE = "caddy:2.9-alpine";

function getCaddyfilePath(): string {
  return join(CADDY_DIR, "Caddyfile");
}

interface ProxyRouteRow {
  id: string;
  app_id: string | null;
  domain: string;
  upstream: string;
  tls_mode: "auto" | "selfsigned" | "manual" | "off";
  enabled: number;
}

function loadRoutes(): ProxyRouteRow[] {
  return db.all(sql`SELECT * FROM proxy_routes WHERE enabled = 1`) as ProxyRouteRow[];
}

function loadAuthConfig(): { enabled: boolean; verifyUrl: string; bypassAppIds: string[] } | undefined {
  const authEnabled = getSetting("proxy_auth_enabled");
  if (authEnabled !== "true") return undefined;

  // The verify URL points to the Talome core API — accessible from the Caddy container
  // via the proxy network. Use the container name + internal port.
  const coreHost = getSetting("proxy_auth_core_host") || "host.docker.internal:4000";
  const bypassRaw = getSetting("proxy_auth_bypass_apps");
  const bypassAppIds = bypassRaw ? bypassRaw.split(",").map((s) => s.trim()).filter(Boolean) : [];

  return {
    enabled: true,
    verifyUrl: `http://${coreHost}`,
    bypassAppIds,
  };
}

export async function writeCaddyfileAndReload(): Promise<void> {
  const routes = loadRoutes();
  const email = getSetting("proxy_email");
  const auth = loadAuthConfig();

  const content = generateCaddyfile(
    routes.map((r) => ({
      domain: r.domain,
      upstream: r.upstream,
      tlsMode: r.tls_mode,
      enabled: r.enabled === 1,
      appId: r.app_id ?? undefined,
    })),
    email,
    auth,
  );

  mkdirSync(CADDY_DIR, { recursive: true });
  const caddyfilePath = getCaddyfilePath();

  // Only write if content changed
  const existing = existsSync(caddyfilePath) ? readFileSync(caddyfilePath, "utf-8") : "";
  if (existing === content) return;

  atomicWriteFileSync(caddyfilePath, content);

  // Reload Caddy if running
  try {
    const container = docker.getContainer(CADDY_CONTAINER_NAME);
    const info = await container.inspect();
    if (info.State.Running) {
      // Caddy supports config reload via SIGUSR1, but the simplest is to use the admin API
      // or just exec caddy reload
      const exec = await container.exec({
        Cmd: ["caddy", "reload", "--config", "/etc/caddy/Caddyfile"],
        AttachStdout: true,
        AttachStderr: true,
      });
      await exec.start({});
    }
  } catch {
    // Container not running — will pick up new config on next start
  }
}

export async function ensureCaddyRunning(): Promise<{ ok: boolean; error?: string }> {
  await ensureProxyNetwork();
  mkdirSync(CADDY_DIR, { recursive: true });
  mkdirSync(join(CADDY_DIR, "data"), { recursive: true });
  mkdirSync(join(CADDY_DIR, "config"), { recursive: true });

  // Write initial Caddyfile if missing
  const caddyfilePath = getCaddyfilePath();
  if (!existsSync(caddyfilePath)) {
    atomicWriteFileSync(caddyfilePath, generateCaddyfile([]));
  }

  try {
    const container = docker.getContainer(CADDY_CONTAINER_NAME);
    const info = await container.inspect();
    if (!info.State.Running) {
      await container.start();
    }
    return { ok: true };
  } catch {
    // Container doesn't exist — create it
  }

  try {
    // Pull image first
    try {
      const stream = await docker.pull(CADDY_IMAGE);
      await new Promise((resolve, reject) => {
        docker.modem.followProgress(stream, (err: Error | null) => err ? reject(err) : resolve(undefined));
      });
    } catch {
      // Image might already exist locally
    }

    const container = await docker.createContainer({
      name: CADDY_CONTAINER_NAME,
      Image: CADDY_IMAGE,
      HostConfig: {
        Binds: [
          `${caddyfilePath}:/etc/caddy/Caddyfile:ro`,
          `${join(CADDY_DIR, "data")}:/data`,
          `${join(CADDY_DIR, "config")}:/config`,
        ],
        PortBindings: {
          "80/tcp": [{ HostPort: "80" }],
          "443/tcp": [{ HostPort: "443" }],
        },
        RestartPolicy: { Name: "unless-stopped" },
        NetworkMode: PROXY_NETWORK,
      },
      ExposedPorts: {
        "80/tcp": {},
        "443/tcp": {},
      },
      Labels: {
        "talome.managed": "true",
        "talome.role": "proxy",
      },
    });

    await container.start();
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg };
  }
}

export async function getCaddyStatus(): Promise<{
  running: boolean;
  containerStatus?: string;
  routeCount: number;
}> {
  const routes = loadRoutes();
  try {
    const container = docker.getContainer(CADDY_CONTAINER_NAME);
    const info = await container.inspect();
    return {
      running: info.State.Running,
      containerStatus: info.State.Status,
      routeCount: routes.length,
    };
  } catch {
    return { running: false, routeCount: routes.length };
  }
}

export async function stopCaddy(): Promise<void> {
  try {
    const container = docker.getContainer(CADDY_CONTAINER_NAME);
    await container.stop();
  } catch {
    // Not running
  }
}

export async function autoRegisterProxyRoute(appId: string, appName: string, port: number): Promise<void> {
  const baseDomain = getSetting("proxy_base_domain");
  const proxyEnabled = getSetting("proxy_enabled");
  if (proxyEnabled !== "true" || !baseDomain) return;

  const domain = `${appId}.${baseDomain}`;
  // Use appId for the container name — appName is the display name and may contain spaces
  const upstream = `${appId}:${port}`;

  // .local domains must use self-signed — Let's Encrypt can't issue certs for them
  const isLocal = baseDomain.endsWith(".local") || baseDomain.endsWith(".lan") || baseDomain.endsWith(".home");
  const defaultTls = getSetting("proxy_default_tls") || "auto";
  const tlsMode = isLocal ? "selfsigned" : defaultTls;

  // Check if route already exists
  const existing = db.get(sql`SELECT id FROM proxy_routes WHERE app_id = ${appId}`) as { id: string } | undefined;
  if (existing) return;

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  db.run(sql`INSERT INTO proxy_routes (id, app_id, domain, upstream, tls_mode, created_at) VALUES (${id}, ${appId}, ${domain}, ${upstream}, ${tlsMode}, ${now})`);

  // Connect the app's container to the proxy network
  try {
    await connectContainerToProxyNetwork(appId);
  } catch {
    // Non-fatal
  }

  await writeCaddyfileAndReload();
}

export async function removeProxyRoutesForApp(appId: string): Promise<void> {
  db.run(sql`DELETE FROM proxy_routes WHERE app_id = ${appId}`);
  await writeCaddyfileAndReload();
}
