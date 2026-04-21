import { Hono } from "hono";
import { z } from "zod";
import {
  enableLocalDomains,
  disableLocalDomains,
  getLocalDomainsStatus,
} from "../proxy/local-domains.js";

export const mdns = new Hono();

// Get status (now returns unified local domains status)
mdns.get("/", async (c) => {
  const status = await getLocalDomainsStatus();
  return c.json(status);
});

// Enable local domains (backward-compatible endpoint)
const enableSchema = z.object({
  baseDomain: z.string().min(1).default("talome.local"),
});

mdns.post("/enable", async (c) => {
  const body = enableSchema.safeParse(await c.req.json());
  if (!body.success) return c.json({ error: body.error.flatten() }, 400);

  const result = await enableLocalDomains(body.data.baseDomain);
  if (!result.ok) return c.json({ error: result.error }, 500);

  return c.json({
    ok: true,
    proxyRoutes: result.proxyRoutes,
    message: `Local domains enabled — ${result.proxyRoutes.length} proxy route(s) created`,
  });
});

// Disable local domains
mdns.post("/disable", async (c) => {
  await disableLocalDomains();
  return c.json({ ok: true, message: "Local domains disabled" });
});

// Refresh (re-enable with current settings)
mdns.post("/refresh", async (c) => {
  const status = await getLocalDomainsStatus();
  if (!status.enabled) {
    return c.json({ ok: true, message: "Local domains not enabled" });
  }
  const result = await enableLocalDomains(status.baseDomain);
  return c.json({
    ok: true,
    message: `Refreshed — ${result.proxyRoutes.length} route(s)`,
  });
});
