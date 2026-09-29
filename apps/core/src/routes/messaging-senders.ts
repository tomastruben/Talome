import { Hono } from "hono";
import { z } from "zod";
import { serverError } from "../middleware/request-logger.js";
import {
  MESSAGING_PLATFORMS,
  SENDER_ID_PATTERN,
  allowSender,
  listSenders,
  removeSender,
  type MessagingPlatform,
} from "../messaging/allowlist.js";

/**
 * Allowed chat-bot senders (mounted at /api/integrations/messaging/senders).
 *
 * The Telegram/Discord bots answer only senders listed here as "allowed";
 * refused senders are listed as "rejected" so the owner can allow them with
 * one click. Admin-only: allowing a sender gives them owner-level access to
 * the agent through the bot.
 */
export const messagingSenders = new Hono();

messagingSenders.use("*", async (c, next) => {
  const role = c.get("sessionRole" as never) as string | undefined;
  if (role !== "admin") return c.json({ error: "Forbidden — admin access required" }, 403);
  await next();
});

const platformSchema = z.enum(MESSAGING_PLATFORMS as [MessagingPlatform, ...MessagingPlatform[]]);
const userIdSchema = z.string().trim().regex(SENDER_ID_PATTERN, "User ids are numbers (Telegram user id / Discord user id)");

const allowSchema = z.object({
  platform: platformSchema,
  userId: userIdSchema,
  displayName: z.string().max(80).optional(),
});

const paramsSchema = z.object({ platform: platformSchema, userId: userIdSchema });

messagingSenders.get("/", (c) => {
  try {
    const parsed = platformSchema.optional().safeParse(c.req.query("platform") || undefined);
    if (!parsed.success) return c.json({ error: "Unknown platform" }, 400);
    return c.json({ senders: listSenders(parsed.data) });
  } catch (err) {
    return serverError(c, err, { message: "Failed to list chat bot senders" });
  }
});

// Allow a sender (new, or one the bot refused)
messagingSenders.post("/", async (c) => {
  try {
    const parsed = allowSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.issues.map((i) => i.message).join(", ") }, 400);
    const sender = allowSender(parsed.data.platform, parsed.data.userId, parsed.data.displayName);
    return c.json({ ok: true, sender });
  } catch (err) {
    return serverError(c, err, { message: "Failed to allow chat bot sender" });
  }
});

// Remove a sender (revokes access, or dismisses a refused one)
messagingSenders.delete("/:platform/:userId", (c) => {
  try {
    const parsed = paramsSchema.safeParse(c.req.param());
    if (!parsed.success) return c.json({ error: "Invalid platform or user id" }, 400);
    const removed = removeSender(parsed.data.platform, parsed.data.userId);
    if (!removed) return c.json({ error: "Sender not found" }, 404);
    return c.json({ ok: true });
  } catch (err) {
    return serverError(c, err, { message: "Failed to remove chat bot sender" });
  }
});
