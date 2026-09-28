import { Hono } from "hono";
import { z } from "zod";
import { requirePermission } from "../middleware/require-permission.js";
import {
  getVerificationHistory,
  isVerifiableApp,
  isVerifiableStack,
  listProbedApps,
  listVerifiableStacks,
  resolveStackId,
  verifyApp,
  verifyStack,
  getLatestVerificationResult,
} from "../verification/index.js";

const verification = new Hono();

const targetIdSchema = z.string().trim().min(1).max(64).regex(/^[a-z0-9][a-z0-9-]*$/i, "Invalid id");

const historyQuerySchema = z.object({
  history: z.coerce.number().int().min(1).max(20).optional(),
});

const runBodySchema = z
  .object({
    appId: targetIdSchema.optional(),
    stackId: targetIdSchema.optional(),
    includeActive: z.boolean().optional(),
  })
  .refine((b) => Boolean(b.appId) !== Boolean(b.stackId), { message: "Provide exactly one of appId or stackId" });

/** GET /api/verification — which apps/stacks can be verified, with their latest result. */
verification.get("/", (c) => {
  const apps = listProbedApps().map((id) => {
    const latest = getLatestVerificationResult("app", id);
    return { id, status: latest?.status ?? null, verifiedAt: latest?.verifiedAt ?? null, summary: latest?.summary ?? null };
  });
  const stacks = listVerifiableStacks().map((s) => {
    const latest = getLatestVerificationResult("stack", s.id);
    return { ...s, status: latest?.status ?? null, verifiedAt: latest?.verifiedAt ?? null, summary: latest?.summary ?? null };
  });
  return c.json({ apps, stacks });
});

/** GET /api/verification/apps/:id — last persisted result (?history=N for the last N runs). */
verification.get("/apps/:id", (c) => {
  const id = targetIdSchema.safeParse(c.req.param("id"));
  if (!id.success) return c.json({ error: "Invalid app id" }, 400);
  const appId = id.data.toLowerCase();
  if (!isVerifiableApp(appId)) return c.json({ error: `No outcome probe for app '${appId}'`, verifiableApps: listProbedApps() }, 404);
  const query = historyQuerySchema.safeParse({ history: c.req.query("history") });
  if (!query.success) return c.json({ error: query.error.flatten() }, 400);
  const history = getVerificationHistory("app", appId, query.data.history ?? 1);
  return c.json({ result: history[0] ?? null, ...(query.data.history ? { history } : {}) });
});

/** GET /api/verification/stacks/:id — last persisted result for a stack. */
verification.get("/stacks/:id", (c) => {
  const id = targetIdSchema.safeParse(c.req.param("id"));
  if (!id.success) return c.json({ error: "Invalid stack id" }, 400);
  const stackId = resolveStackId(id.data);
  if (!stackId || !isVerifiableStack(stackId)) {
    return c.json({ error: `No outcome probe for stack '${id.data}'`, verifiableStacks: listVerifiableStacks().map((s) => s.id) }, 404);
  }
  const query = historyQuerySchema.safeParse({ history: c.req.query("history") });
  if (!query.success) return c.json({ error: query.error.flatten() }, 400);
  const history = getVerificationHistory("stack", stackId, query.data.history ?? 1);
  return c.json({ result: history[0] ?? null, ...(query.data.history ? { history } : {}) });
});

/** POST /api/verification/run — { appId } or { stackId }, optional includeActive (admin only). */
verification.post("/run", requirePermission("apps"), async (c) => {
  const parsed = runBodySchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
  const { appId, stackId, includeActive } = parsed.data;

  // Active probes write disposable test data into apps — admins only.
  if (includeActive) {
    const role = c.get("sessionRole" as never) as string | undefined;
    if (role !== "admin") return c.json({ error: "Forbidden — active probes require admin access" }, 403);
  }

  const outcome = appId
    ? await verifyApp(appId, { includeActive })
    : await verifyStack(stackId as string, { includeActive });
  if (!outcome.ok) return c.json({ error: outcome.error }, 404);
  return c.json({ result: outcome.result });
});

export { verification };
