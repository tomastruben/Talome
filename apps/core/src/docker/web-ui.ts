import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { Container } from "@talome/types";

type WebUi = NonNullable<Container["webUi"]>;
const NON_HTTP = new Set([21, 22, 25, 53, 110, 111, 139, 143, 389, 445, 465, 587, 636, 993, 995, 1433, 1521, 1900, 3306, 5353, 5432, 6379, 6881, 7359, 11211, 27017]);
const PREFERRED = [80, 3000, 8080, 8096, 8123, 8025, 9000, 7878, 8989, 9696, 5055, 8787, 9117, 443, 8443, 9443];

/** Only local published ports are inspected; Docker labels cannot supply an arbitrary host. */
export function webUiCandidates(container: Container): WebUi[] {
  if (container.status !== "running" || container.labels?.["talome.ui.enabled"] === "false" || ["proxy", "dns", "mdns", "tailscale"].includes(container.labels?.["talome.role"])) return [];
  const labels = container.labels ?? {};
  const explicit = labels["talome.ui.port"];
  const ports = container.ports.filter(p => p.protocol === "tcp" && p.host > 0 && p.host <= 65535);
  if (container.networkMode === "host") {
    const hostPort = explicit ? Number(explicit) : /(?:^|\/)home-?assistant(?:[:/]|$)/i.test(container.image) ? 8123 : undefined;
    if (hostPort && Number.isInteger(hostPort) && hostPort > 0 && hostPort <= 65535) ports.push({ host: hostPort, container: hostPort, protocol: "tcp" });
  }
  const path = labels["talome.ui.path"] || "/";
  if (!path.startsWith("/") || path.startsWith("//") || /[\\\r\n]/.test(path)) return [];
  const selected = explicit ? ports.filter(p => p.container === Number(explicit)) : ports.filter(p => !NON_HTTP.has(p.container));
  selected.sort((a, b) => (PREFERRED.indexOf(a.container) < 0 ? 100 : PREFERRED.indexOf(a.container)) - (PREFERRED.indexOf(b.container) < 0 ? 100 : PREFERRED.indexOf(b.container)));
  return [...new Map(selected.map(p => [p.host, p])).values()].slice(0, 4).map(p => ({
    port: p.host, path,
    protocol: labels["talome.ui.protocol"] === "http" ? "http" : labels["talome.ui.protocol"] === "https" || [443, 8443, 9443, 8920].includes(p.container) ? "https" : "http",
    title: labels["talome.ui.name"]?.trim().slice(0, 80), source: explicit ? "configured" : "detected",
  }));
}

export function browserPageTitle(status: number, contentType: string, html: string): string | undefined {
  if (status < 200 || status >= 400 || !/text\/html|application\/xhtml\+xml/i.test(contentType)) return undefined;
  // HTTP/JSON endpoints, plain status messages and generic error pages aren't launchable apps.
  if (!/<(?:script|form|button|input)\b/i.test(html)) return undefined;
  const title = html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]?.trim();
  return (title || "Web app").replace(/&amp;/g, "&").replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ").slice(0, 80);
}

/** Bounded GET: no cookies/credentials, no external redirects, at most 64 KiB. */
export async function probeWebUi(candidate: WebUi): Promise<WebUi | null> {
  const deadline = Date.now() + 3000;
  const origin = `${candidate.protocol}://127.0.0.1:${candidate.port}`;
  async function visit(path: string, redirects: number): Promise<WebUi | null> {
    if (Date.now() >= deadline) return null;
    return new Promise(resolve => {
      let settled = false;
      const finish = (value: WebUi | null) => { if (!settled) { settled = true; clearTimeout(timer); resolve(value); } };
      const request = (candidate.protocol === "https" ? httpsRequest : httpRequest)(new URL(path, origin), {
        method: "GET", headers: { Accept: "text/html", "User-Agent": "Talome-UI-Discovery/1" },
        // Scoped to the literal loopback address above, for local self-signed app certificates.
        ...(candidate.protocol === "https" ? { rejectUnauthorized: false } : {}),
      }, response => {
        const status = response.statusCode ?? 0;
        if (status >= 300 && status < 400 && response.headers.location && redirects < 3) {
          let target: URL;
          try { target = new URL(response.headers.location, new URL(path, origin)); } catch { response.destroy(); finish(null); return; }
          if (target.origin !== origin || target.username || target.password) { response.destroy(); finish(null); return; }
          response.resume();
          void visit(target.pathname + target.search, redirects + 1).then(finish);
          return;
        }
        const chunks: Buffer[] = []; let bytes = 0;
        const complete = () => {
          const title = browserPageTitle(status, String(response.headers["content-type"] ?? ""), Buffer.concat(chunks).toString("utf8"));
          finish(title ? { ...candidate, title: candidate.title || title } : null);
        };
        response.on("data", (chunk: Buffer) => {
          const remaining = 65536 - bytes; chunks.push(chunk.subarray(0, remaining)); bytes += Math.min(chunk.length, remaining);
          if (bytes >= 65536) { complete(); response.destroy(); }
        });
        response.on("end", complete);
        response.on("error", () => finish(null));
      });
      const timer = setTimeout(() => { finish(null); request.destroy(); }, Math.max(1, deadline - Date.now()));
      request.on("error", () => finish(null)); request.end();
    });
  }
  return visit(candidate.path, 0);
}

/** Positive results last five minutes; failed detection retries after thirty seconds. */
export function createWebUiDiscovery(probe = probeWebUi, now = Date.now) {
  const cache = new Map<string, { expires: number; result: Promise<WebUi | null> }>();
  return async (containers: Container[]): Promise<Container[]> => {
    const activeIds = new Set(containers.map(c => c.id));
    for (const key of cache.keys()) if (!activeIds.has(key.split("|")[0])) cache.delete(key);
    const output: Container[] = new Array(containers.length); let next = 0;
    async function worker() {
      while (next < containers.length) {
        const index = next++; const container = containers[index]; const candidates = webUiCandidates(container);
        const key = `${container.id}|${JSON.stringify(candidates)}`;
        let entry = cache.get(key);
        if (!entry || entry.expires <= now()) {
          entry = { expires: Infinity, result: Promise.resolve(null) }; cache.set(key, entry);
          const current = entry;
          current.result = (async () => {
            let result: WebUi | null = null;
            for (const candidate of candidates) {
              // Explicit port labels declare a UI even behind auth or a non-root login flow.
              result = candidate.source === "configured" ? candidate : await probe(candidate).catch(() => null);
              if (result) break;
            }
            current.expires = now() + (result ? 300_000 : 30_000); return result;
          })();
        }
        output[index] = { ...container, webUi: await entry.result };
      }
    }
    await Promise.all(Array.from({ length: Math.min(6, containers.length) }, worker));
    return output;
  };
}

export const discoverContainerWebUis = createWebUiDiscovery();
