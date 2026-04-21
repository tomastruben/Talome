import { Hono } from "hono";
import {
  buildOAuthUrl,
  completeRegistration,
  getStoredTokens,
  clearTokens,
  audibleApiFetch,
  getMarketplaces,
} from "../utils/audible-auth.js";
import { getSetting } from "../utils/settings.js";
import { serverError } from "../middleware/request-logger.js";
import {
  importAudibleBook,
  getImportJobs,
  cancelImport,
  checkFfmpeg,
} from "../utils/audible-import.js";

import { z } from "zod";

export const audible = new Hono();

const authStartSchema = z.object({ marketplace: z.string().min(1).max(50) });
const authCompleteSchema = z.object({ sessionId: z.string().min(1).max(200), url: z.string().min(1).max(2000) });

/* ── Auth: Start OAuth Flow ───────────────────────────── */

audible.post("/auth/start", async (c) => {
  try {
    const parsed = authStartSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    const { marketplace } = parsed.data;

    // Amazon validates return_to — it MUST be their own maplanding URL.
    // Custom callback URLs are rejected. The user will copy the maplanding
    // URL after login and paste it back into the UI.
    const result = buildOAuthUrl(marketplace);

    return c.json(result);
  } catch (err: unknown) {
    return serverError(c, err);
  }
});

/* ── Auth: Complete via Pasted URL ─────────────────────── */

audible.post("/auth/complete", async (c) => {
  try {
    const parsed = authCompleteSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    const { sessionId, url: pastedUrl } = parsed.data;

    // Extract authorization_code from the pasted redirect URL
    const redirectUrl = new URL(pastedUrl);
    const authCode =
      redirectUrl.searchParams.get("openid.oa2.authorization_code") ??
      redirectUrl.searchParams.get("authorization_code");

    if (!authCode) {
      return c.json({ error: "Could not extract authorization code from URL" }, 400);
    }

    const tokens = await completeRegistration(sessionId, authCode);
    return c.json({
      ok: true,
      marketplace: tokens.marketplace,
      customerId: tokens.customerId ?? null,
    });
  } catch (err: unknown) {
    return serverError(c, err);
  }
});

/* ── Auth: Status ─────────────────────────────────────── */

audible.get("/auth-status", (c) => {
  const tokens = getStoredTokens();
  if (!tokens) {
    return c.json({ authenticated: false });
  }
  return c.json({
    authenticated: true,
    marketplace: tokens.marketplace,
    customerId: tokens.customerId ?? null,
  });
});

/* ── Disconnect ───────────────────────────────────────── */

audible.post("/disconnect", (c) => {
  clearTokens();
  return c.json({ ok: true });
});

/* ── Marketplaces ─────────────────────────────────────── */

audible.get("/marketplaces", (c) => {
  return c.json(getMarketplaces());
});

/* ── Library ──────────────────────────────────────────── */

audible.get("/library", async (c) => {
  try {
    const tokens = getStoredTokens();
    if (!tokens) {
      return c.json({ error: "Not authenticated with Audible" }, 401);
    }

    const data = await audibleApiFetch("/1.0/library", tokens, {
      response_groups: "product_desc,product_attrs,contributors,media,category_ladders",
      num_results: c.req.query("limit") ?? "1000",
      page: c.req.query("page") ?? "1",
    });

    const response = data as Record<string, unknown>;
    const items = response.items ?? [];
    return c.json({
      items,
      totalResults: response.total_results ?? null,
    });
  } catch (err: unknown) {
    return serverError(c, err);
  }
});

/* ── Single Book Metadata ─────────────────────────────── */

audible.get("/book/:asin", async (c) => {
  try {
    const tokens = getStoredTokens();
    if (!tokens) {
      return c.json({ error: "Not authenticated with Audible" }, 401);
    }

    const asin = c.req.param("asin");
    const data = await audibleApiFetch(`/1.0/catalog/products/${asin}`, tokens, {
      response_groups: "product_desc,product_attrs,contributors,media,category_ladders,reviews,rating",
    });

    return c.json(data);
  } catch (err: unknown) {
    return serverError(c, err);
  }
});

/* ── Import: Start ───────────────────────────────────────── */

audible.post("/import", async (c) => {
  try {
    const tokens = getStoredTokens();
    if (!tokens) {
      return c.json({ error: "Not authenticated with Audible" }, 401);
    }

    const body = await c.req.json();
    const { asin, title, author, libraryId } = body ?? {};

    if (!asin || typeof asin !== "string") {
      return c.json({ error: "asin is required" }, 400);
    }
    if (!title || typeof title !== "string") {
      return c.json({ error: "title is required" }, 400);
    }
    if (!author || typeof author !== "string") {
      return c.json({ error: "author is required" }, 400);
    }

    const ffmpeg = checkFfmpeg();
    if (!ffmpeg.available) {
      return c.json({ error: "FFmpeg is not available — install FFmpeg to import audiobooks" }, 400);
    }

    const importId = await importAudibleBook(asin, title, author, typeof libraryId === "string" ? libraryId : undefined);
    return c.json({ importId });
  } catch (err: unknown) {
    return serverError(c, err);
  }
});

/* ── Import: List Jobs ───────────────────────────────────── */

audible.get("/imports", (c) => {
  return c.json({ jobs: getImportJobs() });
});

/* ── Import: Check Tools ─────────────────────────────────── */

audible.get("/import-tools", (c) => {
  const ffmpeg = checkFfmpeg();
  return c.json({
    ffmpeg: ffmpeg.available,
    ffmpegVersion: ffmpeg.version ?? null,
  });
});

/* ── Import: Cancel ──────────────────────────────────────── */

audible.delete("/import/:id", (c) => {
  const id = c.req.param("id");
  const cancelled = cancelImport(id);
  if (!cancelled) {
    return c.json({ error: "Import not found or already finished" }, 404);
  }
  return c.json({ ok: true });
});

/* ── Remove Import (delete from Audiobookshelf) ──────── */

audible.post("/remove-import", async (c) => {
  try {
    const absUrl = getSetting("audiobookshelf_url")?.replace(/\/$/, "");
    const absToken = getSetting("audiobookshelf_api_key");
    if (!absUrl || !absToken) {
      return c.json({ error: "Audiobookshelf not configured" }, 400);
    }

    const body = await c.req.json();
    const { itemId } = body ?? {};
    if (!itemId || typeof itemId !== "string") {
      return c.json({ error: "itemId is required" }, 400);
    }

    const res = await fetch(`${absUrl}/api/items/${itemId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${absToken}` },
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return c.json({ error: `Failed to remove: ${text}` }, res.status as any);
    }

    return c.json({ ok: true });
  } catch (err: unknown) {
    return serverError(c, err);
  }
});

/* ── Status ───────────────────────────────────────────── */

audible.get("/status", (c) => {
  const tokens = getStoredTokens();
  return c.json({
    authenticated: !!tokens,
    marketplace: tokens?.marketplace ?? null,
    importAvailable: checkFfmpeg().available,
  });
});

