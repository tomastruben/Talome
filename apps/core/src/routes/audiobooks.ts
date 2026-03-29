import { Hono } from "hono";
import sharp from "sharp";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { getSetting } from "../utils/settings.js";

const COVER_CACHE_DIR = join(homedir(), ".talome", "cache", "covers");
const ALLOWED_WIDTHS = [120, 240, 400] as const;

export const audiobooks = new Hono();

/* ── Helpers — Audiobookshelf ─────────────────────────── */

function getConfig() {
  const baseUrl = getSetting("audiobookshelf_url")?.replace(/\/$/, "");
  const token = getSetting("audiobookshelf_api_key");
  if (!baseUrl || !token) return null;
  return { baseUrl, token };
}

async function absFetch(path: string, init?: RequestInit) {
  const config = getConfig();
  if (!config) throw new Error("Audiobookshelf not configured");
  const res = await fetch(`${config.baseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${config.token}`,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
    signal: init?.signal ?? AbortSignal.timeout(10000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`ABS ${res.status}: ${text}`);
  }
  return res;
}

/* ── Helpers — Prowlarr ───────────────────────────────── */

function getProwlarrConfig() {
  const baseUrl = getSetting("prowlarr_url")?.replace(/\/$/, "");
  const apiKey = getSetting("prowlarr_api_key");
  if (!baseUrl || !apiKey) return null;
  return { baseUrl, apiKey };
}

async function prowlarrGet(path: string): Promise<unknown> {
  const config = getProwlarrConfig();
  if (!config) throw new Error("Prowlarr not configured");
  const res = await fetch(`${config.baseUrl}/api/v1${path}`, {
    headers: { "X-Api-Key": config.apiKey },
    signal: AbortSignal.timeout(45000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Prowlarr ${res.status}: ${text}`);
  }
  return res.json();
}

/* ── Helpers — qBittorrent ───────────────────────────── */

function getQbtConfig() {
  const baseUrl = getSetting("qbittorrent_url")?.replace(/\/$/, "");
  if (!baseUrl) return null;
  return {
    baseUrl,
    username: getSetting("qbittorrent_username") ?? "admin",
    password: getSetting("qbittorrent_password") ?? "",
  };
}

let qbtCookie: string | null = null;

async function qbtLogin(): Promise<void> {
  const config = getQbtConfig();
  if (!config) throw new Error("qBittorrent not configured");
  const res = await fetch(`${config.baseUrl}/api/v2/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `username=${encodeURIComponent(config.username)}&password=${encodeURIComponent(config.password)}`,
    signal: AbortSignal.timeout(10000),
  });
  const setCookie = res.headers.get("set-cookie");
  if (setCookie) qbtCookie = setCookie.split(";")[0];
}

async function qbtFetch(path: string, init?: RequestInit): Promise<Response> {
  const config = getQbtConfig();
  if (!config) throw new Error("qBittorrent not configured");
  if (!qbtCookie) await qbtLogin();

  const doFetch = () =>
    fetch(`${config.baseUrl}${path}`, {
      ...init,
      headers: {
        ...(qbtCookie ? { Cookie: qbtCookie } : {}),
        ...(init?.headers as Record<string, string> ?? {}),
      },
      signal: init?.signal ?? AbortSignal.timeout(10000),
    });

  let res = await doFetch();
  if (res.status === 403) {
    await qbtLogin();
    res = await doFetch();
  }
  return res;
}

// ── External API response interfaces ──────────────────────────────────────────

interface ProwlarrRelease {
  guid?: string;
  title?: string;
  size?: number;
  ageHours?: number;
  indexer?: string;
  seeders?: number | null;
  leechers?: number | null;
  protocol?: string;
  downloadUrl?: string | null;
  infoUrl?: string;
  publishDate?: string;
  categories?: Array<{ id?: number; name?: string }>;
}

interface QBitTorrent {
  hash?: string;
  name?: string;
  state?: string;
  progress?: number;
  total_size?: number;
  size?: number;
  downloaded?: number;
  dlspeed?: number;
  eta?: number;
  added_on?: number;
  completion_on?: number;
  save_path?: string;
}

/* ── Libraries ─────────────────────────────────────────── */

audiobooks.get("/libraries", async (c) => {
  try {
    const res = await absFetch("/api/libraries");
    const data = await res.json() as { libraries: unknown[] };
    return c.json(data.libraries ?? []);
  } catch (err: unknown) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

/* ── Library items (paginated) ─────────────────────────── */

audiobooks.get("/library/:id", async (c) => {
  try {
    const id = c.req.param("id");
    const params = new URLSearchParams({
      limit: c.req.query("limit") ?? "25",
      page: c.req.query("page") ?? "0",
      sort: c.req.query("sort") ?? "media.metadata.title",
      desc: c.req.query("desc") ?? "0",
    });
    const filter = c.req.query("filter");
    if (filter) params.set("filter", filter);
    const res = await absFetch(`/api/libraries/${id}/items?${params}`);
    const data = await res.json();
    return c.json(data);
  } catch (err: unknown) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

/* ── Personalized shelves ──────────────────────────────── */

audiobooks.get("/library/:id/personalized", async (c) => {
  try {
    const id = c.req.param("id");
    const res = await absFetch(`/api/libraries/${id}/personalized`);
    const data = await res.json();
    return c.json(data);
  } catch (err: unknown) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

/* ── Single item detail ────────────────────────────────── */

audiobooks.get("/item/:id", async (c) => {
  try {
    const id = c.req.param("id");
    const res = await absFetch(`/api/items/${id}?expanded=1`);
    const data = await res.json();
    return c.json(data);
  } catch (err: unknown) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

/* ── Search ────────────────────────────────────────────── */

audiobooks.get("/search", async (c) => {
  try {
    const libraryId = c.req.query("libraryId");
    const q = c.req.query("q");
    if (!libraryId || !q) return c.json({ error: "libraryId and q required" }, 400);
    const params = new URLSearchParams({ q, limit: c.req.query("limit") ?? "10" });
    const res = await absFetch(`/api/libraries/${libraryId}/search?${params}`);
    const data = await res.json();
    return c.json(data);
  } catch (err: unknown) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

/* ── Progress (GET + PATCH) ────────────────────────────── */

audiobooks.get("/progress/:id", async (c) => {
  try {
    const id = c.req.param("id");
    const res = await absFetch(`/api/me/progress/${id}`);
    const data = await res.json();
    return c.json(data);
  } catch {
    // 404 means no progress yet — return empty
    return c.json({ currentTime: 0, progress: 0, isFinished: false });
  }
});

audiobooks.patch("/progress/:id", async (c) => {
  const id = c.req.param("id");
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  try {
    const res = await absFetch(`/api/me/progress/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    });
    // ABS may return empty body on success
    const text = await res.text();
    try {
      return c.json(JSON.parse(text));
    } catch {
      return c.json({ ok: true });
    }
  } catch (err: unknown) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

/* ── Cover proxy (resize + cache) ──────────────────────── */

audiobooks.get("/cover", async (c) => {
  const itemId = c.req.query("id");
  if (!itemId) return c.text("id required", 400);

  const config = getConfig();
  if (!config) return c.text("Audiobookshelf not configured", 400);

  const requestedWidth = c.req.query("w") ? parseInt(c.req.query("w")!, 10) : null;
  const width = requestedWidth && (ALLOWED_WIDTHS as readonly number[]).includes(requestedWidth)
    ? requestedWidth
    : null;
  const cacheKey = createHash("md5").update(`abs:${itemId}:${width ?? "default"}`).digest("hex");
  const cachePath = join(COVER_CACHE_DIR, `${cacheKey}.webp`);

  // Serve from cache
  try {
    const cached = await readFile(cachePath);
    return new Response(cached, {
      headers: { "Content-Type": "image/webp", "Cache-Control": "public, max-age=86400" },
    });
  } catch { /* cache miss */ }

  // Fetch from Audiobookshelf
  try {
    const res = await fetch(`${config.baseUrl}/api/items/${itemId}/cover`, {
      headers: { Authorization: `Bearer ${config.token}` },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return c.text("Not found", 404);
    const buf = Buffer.from(await res.arrayBuffer());
    const resized = await sharp(buf)
      .resize(width ?? 240, undefined, { fit: "inside", withoutEnlargement: true })
      .webp({ quality: 80 })
      .toBuffer();
    mkdir(COVER_CACHE_DIR, { recursive: true }).then(() => writeFile(cachePath, resized)).catch(() => {});
    return new Response(
      resized.buffer.slice(resized.byteOffset, resized.byteOffset + resized.byteLength) as ArrayBuffer,
      { headers: { "Content-Type": "image/webp", "Cache-Control": "public, max-age=86400" } },
    );
  } catch {
    return c.text("Failed to fetch cover", 502);
  }
});

/* ── Audio stream proxy ────────────────────────────────── */

audiobooks.get("/stream/:id", async (c) => {
  const config = getConfig();
  if (!config) return c.text("Audiobookshelf not configured", 400);

  const id = c.req.param("id");
  try {
    const res = await absFetch(`/api/items/${id}?expanded=1`);
    const item = await res.json() as Record<string, unknown>;
    const media = item.media as Record<string, unknown> | undefined;
    const audioFiles = (media?.audioFiles ?? []) as Array<Record<string, unknown>>;

    // Proxy through Talome so the browser doesn't need direct ABS access
    const tracks = audioFiles.map((af) => ({
      index: af.index,
      ino: af.ino,
      duration: af.duration,
      metadata: af.metadata,
      streamUrl: `/api/audiobooks/file/${id}/${af.ino}`,
    }));

    return c.json({ tracks });
  } catch (err: unknown) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

/* ── Audio file proxy (streams audio through Talome) ───── */

audiobooks.get("/file/:itemId/:ino", async (c) => {
  const config = getConfig();
  if (!config) return c.text("Audiobookshelf not configured", 400);

  const { itemId, ino } = c.req.param();
  const range = c.req.header("Range");

  try {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${config.token}`,
    };
    if (range) headers["Range"] = range;

    const res = await fetch(`${config.baseUrl}/api/items/${itemId}/file/${ino}`, {
      headers,
      signal: AbortSignal.timeout(30000),
    });

    if (!res.ok && res.status !== 206) {
      return c.text("Audio file not found", 404);
    }

    const responseHeaders = new Headers();
    for (const key of ["content-type", "content-length", "content-range", "accept-ranges"]) {
      const val = res.headers.get(key);
      if (val) responseHeaders.set(key, val);
    }
    responseHeaders.set("Cache-Control", "public, max-age=86400");

    return new Response(res.body, {
      status: res.status,
      headers: responseHeaders,
    });
  } catch {
    return c.text("Failed to stream audio", 502);
  }
});

/* ═══════════════════════════════════════════════════════════
   Prowlarr — Direct audiobook search via indexers
   qBittorrent — Download management
   ═══════════════════════════════════════════════════════════ */

/* ── Search status (checks Prowlarr + qBittorrent) ────────── */

audiobooks.get("/search/status", async (c) => {
  const prowlarr = getProwlarrConfig();
  const qbt = getQbtConfig();
  return c.json({
    configured: !!prowlarr && !!qbt,
    prowlarr: !!prowlarr,
    qbittorrent: !!qbt,
  });
});

/* ── Language detection (shared with tool) ──────────────────── */

const LANG_PATTERNS: Array<{ lang: string; patterns: RegExp[] }> = [
  { lang: "CZ", patterns: [/\bCZ\b/, /\bczech\b/i, /\bčesk/i, /\baudiokniha\b/i, /\bčeština\b/i] },
  { lang: "SK", patterns: [/\bSK\b/, /\bslovak\b/i, /\bslovens/i] },
  { lang: "EN", patterns: [/\bEN\b/, /\benglish\b/i] },
  { lang: "DE", patterns: [/\bDE\b/, /\bgerman\b/i, /\bdeutsch\b/i, /\bhörbuch\b/i] },
  { lang: "PL", patterns: [/\bPL\b/, /\bpolish\b/i, /\bpolsk/i] },
  { lang: "RU", patterns: [/\bRU\b/, /\brussian\b/i, /\bрус/i] },
  { lang: "FR", patterns: [/\bFR\b/, /\bfrench\b/i, /\bfrançais/i] },
];

function detectLang(title: string): string | null {
  if (/\baudiokniha\b/i.test(title)) {
    if (/\bSK\b/.test(title) || /\bslovak/i.test(title) || /\bslovens/i.test(title)) return "SK";
    return "CZ";
  }
  for (const { lang, patterns } of LANG_PATTERNS) {
    if (lang === "EN") continue;
    if (patterns.some((p) => p.test(title))) return lang;
  }
  if (/\baudiobook\b/i.test(title)) return "EN";
  return null;
}

/* ── Search audiobooks via Prowlarr (category 3030) ────────── */

audiobooks.get("/search/releases", async (c) => {
  const query = c.req.query("q") ?? "";
  if (!query) return c.json({ releases: [] });

  const langFilter = c.req.query("lang")?.toUpperCase() ?? null;

  try {
    const params = new URLSearchParams({
      query,
      type: "search",
    });
    const rawResult = await prowlarrGet(`/search?${params}`);
    const raw = (rawResult ?? []) as ProwlarrRelease[];
    const AUDIO_CATS = new Set([3000, 3010, 3020, 3030, 3040]);
    const releases = raw
      .map((r) => {
        const title = r.title ?? "Unknown release";
        const cats: number[] = (r.categories ?? []).map((c) => c.id ?? 0);
        return {
          guid: r.guid ?? null,
          title,
          size: Number(r.size ?? 0),
          ageHours: r.ageHours ?? null,
          indexer: r.indexer ?? null,
          seeders: typeof r.seeders === "number" ? r.seeders : null,
          leechers: typeof r.leechers === "number" ? r.leechers : null,
          protocol: r.protocol ?? null,
          downloadUrl: r.downloadUrl ?? null,
          infoUrl: r.infoUrl ?? null,
          publishDate: r.publishDate ?? null,
          language: detectLang(title),
          _isAudioCat: cats.some((id) => AUDIO_CATS.has(id)),
        };
      })
      .filter((r) => {
        // Include if categorized under audio OR title matches audiobook keywords
        const titleMatch = /audiobook|audiokniha|hörbuch|mp3.*knih|knih.*mp3/i.test(r.title);
        if (!r._isAudioCat && !titleMatch && raw.length > 5) return false;
        // Language filter
        if (langFilter && r.language && r.language !== langFilter) return false;
        return true;
      })
      .map(({ _isAudioCat, ...r }) => r)
      .sort((a, b) => (b.seeders ?? 0) - (a.seeders ?? 0));

    return c.json({ releases, totalFound: raw.length, languageFilter: langFilter });
  } catch (err: unknown) {
    return c.json({ error: err instanceof Error ? err.message : String(err), releases: [] }, 500);
  }
});

/* ── Download a release via qBittorrent ────────────────────── */

audiobooks.post("/search/download", async (c) => {
  const body = await c.req.json().catch(() => ({})) as { downloadUrl?: string; title?: string };
  const { downloadUrl, title } = body;
  if (!downloadUrl) return c.json({ error: "downloadUrl required" }, 400);

  try {
    const formData = new URLSearchParams();
    formData.set("urls", downloadUrl);
    formData.set("category", "audiobooks");

    const res = await qbtFetch("/api/v2/torrents/add", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: formData.toString(),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(text || `qBittorrent ${res.status}`);
    }

    return c.json({ ok: true, title: title ?? "Download started" });
  } catch (err: unknown) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

/* ── Active audiobook downloads from qBittorrent ───────────── */

audiobooks.get("/downloads", async (c) => {
  try {
    const res = await qbtFetch("/api/v2/torrents/info?category=audiobooks");
    if (!res.ok) throw new Error(`qBittorrent ${res.status}`);
    const torrents = (await res.json()) as QBitTorrent[];

    const records = torrents.map((t) => ({
      hash: t.hash,
      name: t.name ?? "Unknown",
      state: t.state ?? "unknown",
      progress: Math.round((t.progress ?? 0) * 100),
      size: t.total_size ?? t.size ?? 0,
      downloaded: t.downloaded ?? 0,
      dlspeed: t.dlspeed ?? 0,
      eta: t.eta ?? 0,
      addedOn: t.added_on ?? 0,
      completionOn: t.completion_on ?? 0,
      savePath: t.save_path ?? "",
    }));

    // Sort: active downloads first, then by addedOn desc
    records.sort((a, b) => {
      const aActive = a.progress < 100 ? 0 : 1;
      const bActive = b.progress < 100 ? 0 : 1;
      if (aActive !== bActive) return aActive - bActive;
      return b.addedOn - a.addedOn;
    });

    return c.json({
      totalRecords: records.length,
      records,
    });
  } catch (err: unknown) {
    return c.json({ error: err instanceof Error ? err.message : String(err), totalRecords: 0, records: [] }, 500);
  }
});

/* ── Remove audiobook download from qBittorrent ────────────── */

audiobooks.delete("/downloads/:hash", async (c) => {
  const hash = c.req.param("hash");
  const deleteFiles = c.req.query("deleteFiles") === "true";

  try {
    const formData = new URLSearchParams();
    formData.set("hashes", hash);
    formData.set("deleteFiles", deleteFiles ? "true" : "false");

    const res = await qbtFetch("/api/v2/torrents/delete", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: formData.toString(),
    });

    if (!res.ok) throw new Error(`qBittorrent ${res.status}`);
    return c.json({ ok: true });
  } catch (err: unknown) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});
