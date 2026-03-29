import { Hono } from "hono";
import { readFile, readdir, writeFile, unlink, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { getCustomTools, loadCustomTools } from "../ai/custom-tools.js";

const CUSTOM_TOOLS_DIR = join(
  process.env.HOME || "/tmp",
  ".talome",
  "custom-tools",
);

async function ensureDir() {
  if (!existsSync(CUSTOM_TOOLS_DIR)) {
    await mkdir(CUSTOM_TOOLS_DIR, { recursive: true });
  }
}

// Mirrors the validation in custom-tools.ts
function validateToolCode(code: string): { ok: boolean; error?: string } {
  const required: Array<[RegExp, string]> = [
    [/export\s+(default\s+)?const\s+\w+\s*=\s*tool\(/, "No tool() exports found"],
    [/import.*from\s+['"]ai['"]/, "Missing import from 'ai'"],
  ];
  for (const [pattern, msg] of required) {
    if (!pattern.test(code)) return { ok: false, error: msg };
  }
  const forbidden: Array<[RegExp, string]> = [
    [/process\.exit/, "process.exit() not allowed"],
    [/require\s*\(\s*['"]child_process['"]/, "child_process not allowed"],
    [/eval\s*\(/, "eval() not allowed"],
    [/Function\s*\(/, "Function constructor not allowed"],
  ];
  for (const [pattern, msg] of forbidden) {
    if (pattern.test(code)) return { ok: false, error: msg };
  }
  return { ok: true };
}

function sanitizeCode(code: string): string {
  const secretPattern = /(?:api[_-]?key|token|password|secret|bearer)\s*[:=]\s*['"][^'"]{8,}['"]/gi;
  return code.replace(secretPattern, (m) => m.replace(/['"][^'"]{8,}['"]/g, '"<REDACTED>"'));
}

export const tools = new Hono();

// ── GET /api/tools/list ───────────────────────────────────────────────────────

tools.get("/list", async (c) => {
  try {
    const files = (await readdir(CUSTOM_TOOLS_DIR).catch(() => [])).filter(
      (f: string) => f.endsWith(".ts") || f.endsWith(".js"),
    );

    const result: { file: string; preview: string }[] = [];
    for (const file of files) {
      const content = await readFile(join(CUSTOM_TOOLS_DIR, file), "utf-8").catch(() => "");
      result.push({ file, preview: content.slice(0, 200) });
    }

    const activeTools = Object.keys(getCustomTools());
    return c.json({ files: result, activeTools, directory: CUSTOM_TOOLS_DIR });
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

// ── POST /api/tools/install ───────────────────────────────────────────────────
// Validates + writes a tool file, then reloads the tool registry.

tools.post("/install", async (c) => {
  const { filename, code } = await c.req.json<{ filename: string; code: string }>();

  if (!filename || filename.includes("..") || filename.includes("/")) {
    return c.json({ ok: false, error: "Invalid filename" }, 400);
  }
  if (!filename.endsWith(".ts") && !filename.endsWith(".js")) {
    return c.json({ ok: false, error: "Filename must end in .ts or .js" }, 400);
  }
  if (!code || !code.trim()) {
    return c.json({ ok: false, error: "Code is required" }, 400);
  }

  const validation = validateToolCode(code);
  if (!validation.ok) {
    return c.json({ ok: false, error: validation.error }, 422);
  }

  try {
    await ensureDir();
    await writeFile(join(CUSTOM_TOOLS_DIR, filename), code, "utf-8");
    const loaded = await loadCustomTools();
    return c.json({ ok: true, activeTools: Object.keys(loaded) });
  } catch (err) {
    return c.json({ ok: false, error: String(err) }, 500);
  }
});

// ── DELETE /api/tools/:filename ───────────────────────────────────────────────

tools.delete("/:filename", async (c) => {
  const filename = c.req.param("filename");

  if (!filename || filename.includes("..") || filename.includes("/")) {
    return c.json({ ok: false, error: "Invalid filename" }, 400);
  }
  if (!filename.endsWith(".ts") && !filename.endsWith(".js")) {
    return c.json({ ok: false, error: "Only .ts or .js files can be deleted" }, 400);
  }

  try {
    await unlink(join(CUSTOM_TOOLS_DIR, filename));
    const loaded = await loadCustomTools();
    return c.json({ ok: true, activeTools: Object.keys(loaded) });
  } catch (err: any) {
    if (err.code === "ENOENT") return c.json({ ok: false, error: "File not found" }, 404);
    return c.json({ ok: false, error: String(err) }, 500);
  }
});

// ── POST /api/tools/share ─────────────────────────────────────────────────────
// Returns sanitised source code for clipboard sharing.

tools.post("/share", async (c) => {
  const { filename } = await c.req.json<{ filename: string }>();

  if (!filename || filename.includes("..") || filename.includes("/")) {
    return c.json({ error: "Invalid filename" }, 400);
  }
  if (!filename.endsWith(".ts") && !filename.endsWith(".js")) {
    return c.json({ error: "Only .ts or .js files can be shared" }, 400);
  }

  try {
    const content = await readFile(join(CUSTOM_TOOLS_DIR, filename), "utf-8");
    const sanitized = sanitizeCode(content);
    return c.json({ filename, code: sanitized, sanitized: sanitized !== content });
  } catch {
    return c.json({ error: "File not found" }, 404);
  }
});

// ── POST /api/tools/publish ───────────────────────────────────────────────────
// Publishes a tool as an anonymous GitHub Gist, returns the shareable URL.

tools.post("/publish", async (c) => {
  const { filename } = await c.req.json<{ filename: string }>();

  if (!filename || filename.includes("..") || filename.includes("/")) {
    return c.json({ ok: false, error: "Invalid filename" }, 400);
  }
  if (!filename.endsWith(".ts") && !filename.endsWith(".js")) {
    return c.json({ ok: false, error: "Only .ts or .js files can be published" }, 400);
  }

  try {
    const content = await readFile(join(CUSTOM_TOOLS_DIR, filename), "utf-8");
    const sanitized = sanitizeCode(content);

    const res = await fetch("https://api.github.com/gists", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "Talome-App",
        Accept: "application/vnd.github+json",
      },
      body: JSON.stringify({
        description: `Talome custom tool: ${filename}`,
        public: true,
        files: {
          [filename]: { content: sanitized },
        },
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      return c.json({ ok: false, error: `GitHub API error: ${res.status} ${err}` }, 502);
    }

    const gist = await res.json() as { id: string; html_url: string; files: Record<string, { raw_url: string }> };
    const rawUrl = gist.files[filename]?.raw_url ?? "";

    return c.json({ ok: true, url: gist.html_url, rawUrl, gistId: gist.id });
  } catch (err) {
    return c.json({ ok: false, error: String(err) }, 500);
  }
});

// ── POST /api/tools/install-from-url ─────────────────────────────────────────
// Fetches raw tool code from a URL (GitHub Gist raw, etc.), validates, installs.

tools.post("/install-from-url", async (c) => {
  const { url } = await c.req.json<{ url: string }>();

  if (!url || typeof url !== "string") {
    return c.json({ ok: false, error: "url is required" }, 400);
  }

  // Only allow https: URLs to prevent SSRF to internal services
  if (!url.startsWith("https://")) {
    return c.json({ ok: false, error: "Only https:// URLs are allowed" }, 400);
  }

  // Derive a raw URL: if it's a GitHub Gist HTML URL, fetch the API to get raw_url
  let rawUrl = url;
  let filename = "";

  // gist.github.com/<user>/<id>  → fetch API to get raw URL + filename
  const gistMatch = url.match(/gist\.github\.com\/[^/]+\/([a-f0-9]+)$/i);
  if (gistMatch) {
    const gistId = gistMatch[1];
    const apiRes = await fetch(`https://api.github.com/gists/${gistId}`, {
      headers: { "User-Agent": "Talome-App", Accept: "application/vnd.github+json" },
    });
    if (!apiRes.ok) return c.json({ ok: false, error: "Could not fetch Gist metadata" }, 502);
    const gist = await apiRes.json() as { files: Record<string, { raw_url: string; filename: string }> };
    const firstFile = Object.values(gist.files)[0];
    if (!firstFile) return c.json({ ok: false, error: "Gist has no files" }, 422);
    rawUrl = firstFile.raw_url;
    filename = firstFile.filename;
  } else {
    // Derive filename from the last path segment
    filename = url.split("/").pop()?.split("?")[0] ?? "tool.ts";
  }

  if (!filename.endsWith(".ts") && !filename.endsWith(".js")) {
    filename = filename + ".ts";
  }
  if (filename.includes("..") || filename.includes("/")) {
    filename = "imported-tool.ts";
  }

  try {
    const codeRes = await fetch(rawUrl, {
      headers: { "User-Agent": "Talome-App" },
      signal: AbortSignal.timeout(10000),
    });
    if (!codeRes.ok) return c.json({ ok: false, error: `Failed to fetch code: HTTP ${codeRes.status}` }, 502);

    const code = await codeRes.text();
    const validation = validateToolCode(code);
    if (!validation.ok) return c.json({ ok: false, error: validation.error }, 422);

    await ensureDir();
    await writeFile(join(CUSTOM_TOOLS_DIR, filename), code, "utf-8");
    const loaded = await loadCustomTools();
    return c.json({ ok: true, filename, activeTools: Object.keys(loaded) });
  } catch (err) {
    return c.json({ ok: false, error: String(err) }, 500);
  }
});
