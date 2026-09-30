import type { Context, Hono } from "hono";
import type { UpgradeWebSocket, WSContext } from "hono/ws";
import { z } from "zod";
import { getSetting } from "../utils/settings.js";
import { createLogger } from "../utils/logger.js";

/**
 * Full-duplex voice conversations through OpenAI GPT-Live.
 *
 * GPT-Live listens and speaks at the same time and decides its own turns. It has
 * no tools: when the user asks for something that needs Talome, it creates a
 * *client delegation*. The browser answers that by sending the request through
 * the regular assistant chat — same tools, same approvals, same history — and
 * appends the reply as commentary, which GPT-Live speaks in its own words.
 *
 * The browser can't put the API key on a WebSocket, so this route relays:
 * browser ⇄ Talome ⇄ wss://api.openai.com/v1/live/sessions. Talome owns the
 * session configuration; the browser may only stream audio and answer
 * delegations.
 */

const log = createLogger("voice-live");

/** Overridable for gateways (and tests) that speak the same protocol. */
const LIVE_URL = process.env.TALOME_VOICE_LIVE_URL || "wss://api.openai.com/v1/live/sessions";
export const DEFAULT_LIVE_MODEL = "gpt-live-1";
export const DEFAULT_LIVE_VOICE = "marin";
export const LIVE_VOICES = [
  "alloy", "ash", "ballad", "beacon", "bossa", "cedar", "cinder", "coral", "delta", "echo", "gleam",
  "marin", "meridian", "quartz", "ripple", "sage", "shimmer", "stone", "tempo", "verse", "vesper", "willow",
] as const;
/** Sessions end on their own after this long, whatever the provider allows. */
const MAX_SESSION_MS = 30 * 60 * 1000;
/** One PCM16 frame from the browser; ~40 ms at 24 kHz is ~2.6 KB base64. */
const MAX_CLIENT_MESSAGE = 256 * 1024;

export const LIVE_INSTRUCTIONS = `You are Talome, the voice of the user's home server. Speak naturally and briefly, like a calm, capable friend.

## Delegation
You have no tools of your own. The Talome assistant behind you can see and change the server: apps, containers, media libraries, downloads, files, automations, storage and settings. Delegate as soon as the user asks about any of that, or asks for anything that needs a lookup or an action, and include every detail they gave. While it works, keep the conversation going and say briefly that you're on it. Relay its answer in your own words, short enough to say in a breath or two; don't read out lists, IDs or code. If it says your approval is needed, tell the user to approve it on screen. Answer small talk yourself.`;

export interface LiveConfig {
  apiKey: string;
  model: string;
  voice: string;
}

/** GPT-Live runs on the OpenAI key from Settings › AI Provider, unless voice conversations are turned off. */
export function liveConfig(): LiveConfig | null {
  if (getSetting("voice_live_enabled") === "false") return null;
  const apiKey = getSetting("openai_key") || process.env.OPENAI_API_KEY;
  if (!apiKey) return null;
  const voice = getSetting("voice_live_voice");
  return {
    apiKey,
    model: getSetting("voice_live_model")?.trim() || DEFAULT_LIVE_MODEL,
    voice: voice && (LIVE_VOICES as readonly string[]).includes(voice) ? voice : DEFAULT_LIVE_VOICE,
  };
}

const historyItem = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().trim().min(1).max(2000),
});

/** What the browser may send. Everything else is dropped. */
export const clientMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("talome.start"), history: z.array(historyItem).max(20).optional() }),
  z.object({ type: z.literal("session.input_audio.append"), audio: z.string().max(MAX_CLIENT_MESSAGE) }),
  z.object({
    type: z.literal("session.commentary.append"),
    delegation_id: z.string().max(200).nullable(),
    content: z.string().max(4000),
  }),
  z.object({
    type: z.literal("session.thinking.append"),
    delegation_id: z.string().max(200).nullable(),
    content: z.string().max(4000),
  }),
  z.object({ type: z.literal("session.close") }),
]);
export type ClientMessage = z.infer<typeof clientMessageSchema>;

/** The `session.start` Talome sends for a browser's `talome.start`. */
export function buildSessionStart(config: LiveConfig, history: z.infer<typeof historyItem>[] = []) {
  return {
    type: "session.start",
    session: {
      model: config.model,
      instructions: LIVE_INSTRUCTIONS,
      audio: { output: { voice: config.voice }, format: { type: "audio/pcm", rate: 24000 } },
      delegation: { type: "client" },
      ...(history.length > 0
        ? {
            input: history.map((m) => ({
              type: "message",
              role: m.role,
              content: [{ type: m.role === "user" ? "input_text" : "output_text", text: m.content }],
            })),
          }
        : {}),
    },
  };
}

function send(ws: WSContext, payload: unknown) {
  if (ws.readyState === 1) ws.send(JSON.stringify(payload));
}

export function voiceLiveSocket(upgradeWebSocket: UpgradeWebSocket) {
  return upgradeWebSocket((c: Context) => {
    const username = (c.get("sessionUsername" as never) as string | undefined) ?? "unknown";
    let upstream: WebSocket | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let startedAt = 0;

    const shutdown = (ws: WSContext | null, reason?: string) => {
      if (timer) clearTimeout(timer);
      timer = null;
      if (upstream && upstream.readyState <= 1) {
        try {
          if (upstream.readyState === 1) upstream.send(JSON.stringify({ type: "session.close" }));
        } catch {
          // closing anyway
        }
        upstream.close();
      }
      upstream = null;
      if (ws && ws.readyState === 1) {
        if (reason) send(ws, { type: "talome.error", message: reason });
        ws.close(1000, "done");
      }
      if (startedAt) {
        log.info(`voice session for ${username} ended after ${Math.round((Date.now() - startedAt) / 1000)}s`);
        startedAt = 0;
      }
    };

    return {
      onMessage(evt, ws) {
        if (typeof evt.data !== "string" || evt.data.length > MAX_CLIENT_MESSAGE) return;
        let parsed: ClientMessage;
        try {
          const result = clientMessageSchema.safeParse(JSON.parse(evt.data));
          if (!result.success) return;
          parsed = result.data;
        } catch {
          return;
        }

        if (parsed.type === "talome.start") {
          if (upstream) return;
          const config = liveConfig();
          if (!config) {
            shutdown(ws, "GPT-Live is off, or no OpenAI key is set in Settings › AI Provider.");
            return;
          }
          startedAt = Date.now();
          log.info(`voice session for ${username} starting on ${config.model}`);
          const socket = new WebSocket(LIVE_URL, { headers: { Authorization: `Bearer ${config.apiKey}` } } as never);
          upstream = socket;
          socket.onopen = () => socket.send(JSON.stringify(buildSessionStart(config, parsed.history)));
          socket.onmessage = (event) => {
            if (typeof event.data === "string" && ws.readyState === 1) ws.send(event.data);
          };
          socket.onerror = () => shutdown(ws, "Couldn't reach OpenAI GPT-Live.");
          socket.onclose = (event) => {
            if (upstream !== socket) return;
            upstream = null;
            shutdown(ws, event.code === 1000 ? undefined : `GPT-Live closed the session (${event.code}${event.reason ? `: ${event.reason}` : ""}).`);
          };
          timer = setTimeout(() => shutdown(ws, "Voice sessions end after 30 minutes."), MAX_SESSION_MS);
          return;
        }

        if (parsed.type === "session.close") {
          shutdown(ws);
          return;
        }
        if (upstream?.readyState === 1) upstream.send(JSON.stringify(parsed));
      },
      onClose() {
        shutdown(null);
      },
      onError() {
        shutdown(null);
      },
    };
  });
}

export function setupVoiceLive(app: Hono, upgradeWebSocket: UpgradeWebSocket) {
  app.get("/api/voice/live", voiceLiveSocket(upgradeWebSocket));
}
