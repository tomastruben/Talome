import { Hono } from "hono";
import { getSyncStatus } from "../services/overseerr-sync.js";

const services = new Hono();

services.get("/overseerr/sync-status", async (c) => {
  const result = await getSyncStatus();
  if ("error" in result) {
    return c.json(result, 400);
  }
  return c.json(result);
});

export { services };
