import { Hono } from "hono";
import { getSetting } from "../utils/settings.js";
import { serverError } from "../middleware/request-logger.js";
import { liveConfig, LIVE_VOICES } from "./voice-live.js";

/**
 * Speech-to-text for the assistant's voice input.
 *
 * Audio is forwarded to an OpenAI-compatible transcription endpoint the admin
 * configures (`voice_stt_url`), e.g. a faster-whisper server on the same network
 * so audio never leaves home, or OpenAI itself. Without one, the dashboard falls
 * back to the browser's own speech recognition.
 */
const voice = new Hono();

/** Upper bound for one recording (~10+ minutes of Opus). */
const MAX_AUDIO_BYTES = 5 * 1024 * 1024;
const DEFAULT_MODEL = "whisper-1";

function sttConfig() {
  const url = getSetting("voice_stt_url")?.trim().replace(/\/+$/, "");
  if (!url) return null;
  return {
    url,
    apiKey: getSetting("voice_stt_key"),
    model: getSetting("voice_stt_model")?.trim() || DEFAULT_MODEL,
  };
}

voice.get("/status", (c) => {
  const config = sttConfig();
  const live = liveConfig();
  return c.json({
    server: config !== null,
    model: config?.model ?? null,
    // Full-duplex conversations through GPT-Live, when an OpenAI key is set
    live: live ? { model: live.model, voice: live.voice } : null,
    liveVoices: LIVE_VOICES,
  });
});

voice.post("/transcribe", async (c) => {
  const config = sttConfig();
  if (!config) return c.json({ ok: false, error: "No speech-to-text server is configured" }, 404);

  try {
    const audio = await c.req.arrayBuffer();
    if (audio.byteLength === 0) return c.json({ ok: false, error: "Empty recording" }, 400);
    if (audio.byteLength > MAX_AUDIO_BYTES) return c.json({ ok: false, error: "Recording is too long" }, 413);

    const contentType = c.req.header("content-type")?.split(";")[0] || "audio/webm";
    const extension = contentType.includes("mp4") ? "mp4" : contentType.includes("ogg") ? "ogg" : contentType.includes("wav") ? "wav" : "webm";
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(audio)], { type: contentType }), `speech.${extension}`);
    form.append("model", config.model);
    const language = c.req.query("language");
    if (language && /^[a-z]{2}$/.test(language)) form.append("language", language);

    const res = await fetch(`${config.url}/audio/transcriptions`, {
      method: "POST",
      headers: config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : undefined,
      body: form,
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) {
      return c.json({ ok: false, error: `Transcription failed (${res.status})` }, 502);
    }
    const body = (await res.json().catch(() => ({}))) as { text?: unknown };
    const text = typeof body.text === "string" ? body.text.trim() : "";
    return c.json({ ok: true, text });
  } catch (err) {
    return serverError(c, err, { message: "Transcription failed" });
  }
});

export { voice };
