import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

const tempDir = mkdtempSync(join(tmpdir(), "talome-voice-"));
process.env.DATABASE_PATH = join(tempDir, "talome.db");
process.env.TALOME_SECRET = "e".repeat(64);

let fake: Server;
let fakeUrl = "";
const received: { auth?: string; body?: string; contentType?: string } = {};

beforeAll(async () => {
  const { runMigrations } = await import("../db/migrate.js");
  runMigrations();
  fake = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      received.auth = req.headers.authorization;
      received.contentType = req.headers["content-type"];
      received.body = Buffer.concat(chunks).toString("latin1");
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ text: "  restart jellyfin please  " }));
    });
  });
  await new Promise<void>((resolve) => fake.listen(0, "127.0.0.1", resolve));
  fakeUrl = `http://127.0.0.1:${(fake.address() as AddressInfo).port}/v1`;
});

afterAll(() => {
  fake.close();
  rmSync(tempDir, { recursive: true, force: true });
});

async function app() {
  const { Hono } = await import("hono");
  const { voice } = await import("../routes/voice.js");
  const a = new Hono();
  a.route("/api/voice", voice);
  return a;
}

describe("voice transcription", () => {
  it("reports that no server is configured and refuses to transcribe", async () => {
    const a = await app();
    expect(await (await a.request("/api/voice/status")).json()).toMatchObject({ server: false, model: null, live: null });
    const res = await a.request("/api/voice/transcribe", { method: "POST", body: "audio", headers: { "Content-Type": "audio/webm" } });
    expect(res.status).toBe(404);
  });

  it("forwards the recording to the configured OpenAI-compatible endpoint", async () => {
    const { setSetting } = await import("../utils/settings.js");
    setSetting("voice_stt_url", `${fakeUrl}/`);
    setSetting("voice_stt_key", "stt-secret");
    setSetting("voice_stt_model", "Systran/faster-whisper-small");
    const a = await app();

    expect(await (await a.request("/api/voice/status")).json()).toMatchObject({ server: true, model: "Systran/faster-whisper-small", live: null });

    const res = await a.request("/api/voice/transcribe?language=en", {
      method: "POST",
      body: "fake-opus-bytes",
      headers: { "Content-Type": "audio/webm;codecs=opus" },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, text: "restart jellyfin please" });

    // Encrypted key is decrypted before use; audio, model and language are sent as multipart
    expect(received.auth).toBe("Bearer stt-secret");
    expect(received.contentType).toContain("multipart/form-data");
    expect(received.body).toContain('filename="speech.webm"');
    expect(received.body).toContain("fake-opus-bytes");
    expect(received.body).toContain("Systran/faster-whisper-small");
    expect(received.body).toContain('name="language"');
  });

  it("rejects empty recordings", async () => {
    const a = await app();
    const res = await a.request("/api/voice/transcribe", { method: "POST", body: "", headers: { "Content-Type": "audio/webm" } });
    expect(res.status).toBe(400);
  });
});
