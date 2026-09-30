import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { ServerType } from "@hono/node-server";

const tempDir = mkdtempSync(join(tmpdir(), "talome-voice-live-"));
process.env.DATABASE_PATH = join(tempDir, "talome.db");
process.env.TALOME_SECRET = "f".repeat(64);

/** What the fake GPT-Live server saw. */
const upstream: { auth?: string; messages: Record<string, unknown>[] } = { messages: [] };
let fakeServer: ServerType;
let relayServer: ServerType;
let relayUrl = "";

async function listen(app: import("hono").Hono, inject: (s: ServerType) => void): Promise<ServerType> {
  const { serve } = await import("@hono/node-server");
  return new Promise((resolve) => {
    const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, () => resolve(server));
    inject(server);
  });
}

beforeAll(async () => {
  const { runMigrations } = await import("../db/migrate.js");
  runMigrations();
  const { Hono } = await import("hono");
  const { createNodeWebSocket } = await import("@hono/node-ws");

  // A stand-in for wss://api.openai.com/v1/live/sessions
  const fake = new Hono();
  const fakeWs = createNodeWebSocket({ app: fake });
  fake.get(
    "/v1/live/sessions",
    fakeWs.upgradeWebSocket((c) => {
      upstream.auth = c.req.header("authorization");
      return {
        onMessage(evt, ws) {
          const msg = JSON.parse(String(evt.data)) as Record<string, unknown>;
          upstream.messages.push(msg);
          if (msg.type === "session.start") {
            ws.send(JSON.stringify({ type: "session.started", session: { id: "sess_1", model: "gpt-live-1" } }));
            ws.send(JSON.stringify({ type: "session.delegation.created", delegation: { id: "del_1", type: "delegation", target: "client" } }));
          }
        },
      };
    }),
  );
  fakeServer = await listen(fake, fakeWs.injectWebSocket);
  process.env.TALOME_VOICE_LIVE_URL = `ws://127.0.0.1:${(fakeServer.address() as AddressInfo).port}/v1/live/sessions`;

  const { setSetting } = await import("../utils/settings.js");
  setSetting("openai_key", "sk-test-live");
  setSetting("voice_live_voice", "cedar");

  const { setupVoiceLive } = await import("../routes/voice-live.js");
  const app = new Hono();
  const relayWs = createNodeWebSocket({ app });
  setupVoiceLive(app, relayWs.upgradeWebSocket);
  relayServer = await listen(app, relayWs.injectWebSocket);
  relayUrl = `ws://127.0.0.1:${(relayServer.address() as AddressInfo).port}/api/voice/live`;
});

afterAll(() => {
  fakeServer?.close();
  relayServer?.close();
  rmSync(tempDir, { recursive: true, force: true });
});

function nextMessage(ws: WebSocket, type: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`timed out waiting for ${type}`)), 4000);
    const onMessage = (event: MessageEvent) => {
      const msg = JSON.parse(String(event.data)) as Record<string, unknown>;
      if (msg.type !== type) return;
      clearTimeout(timeout);
      ws.removeEventListener("message", onMessage);
      resolve(msg);
    };
    ws.addEventListener("message", onMessage);
  });
}

async function waitFor(check: () => boolean) {
  for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setTimeout(r, 20));
}

describe("GPT-Live relay", () => {
  it("starts the session Talome configures, with the stored key and voice", async () => {
    const ws = new WebSocket(relayUrl);
    await new Promise((resolve) => ws.addEventListener("open", resolve, { once: true }));
    const started = nextMessage(ws, "session.started");
    ws.send(JSON.stringify({ type: "talome.start", history: [{ role: "user", content: "Hi" }] }));
    await started;

    expect(upstream.auth).toBe("Bearer sk-test-live");
    const start = upstream.messages.find((m) => m.type === "session.start") as { session: Record<string, unknown> };
    expect(start.session.model).toBe("gpt-live-1");
    expect(start.session.delegation).toEqual({ type: "client" });
    expect(start.session.audio).toEqual({ output: { voice: "cedar" }, format: { type: "audio/pcm", rate: 24000 } });
    expect(start.session.input).toEqual([{ type: "message", role: "user", content: [{ type: "input_text", text: "Hi" }] }]);
    ws.close();
  });

  it("forwards audio and delegation answers, and drops anything else the browser sends", async () => {
    upstream.messages.length = 0;
    const ws = new WebSocket(relayUrl);
    await new Promise((resolve) => ws.addEventListener("open", resolve, { once: true }));
    const delegation = nextMessage(ws, "session.delegation.created");
    ws.send(JSON.stringify({ type: "talome.start" }));
    await delegation;

    ws.send(JSON.stringify({ type: "session.input_audio.append", audio: "AAAA" }));
    // Not allowed from the browser: reconfiguring the session
    ws.send(JSON.stringify({ type: "session.update", session: { delegation: { type: "responses", responses: {} } } }));
    ws.send(JSON.stringify({ type: "session.commentary.append", delegation_id: "del_1", content: "Jellyfin is running." }));
    await waitFor(() => upstream.messages.some((m) => m.type === "session.commentary.append"));

    // Only this session's traffic: the previous test's socket closes gracefully with a session.close
    const session = upstream.messages.slice(upstream.messages.findIndex((m) => m.type === "session.start"));
    expect(session.map((m) => m.type)).toEqual([
      "session.start",
      "session.input_audio.append",
      "session.commentary.append",
    ]);
    expect(session[2]).toMatchObject({ delegation_id: "del_1", content: "Jellyfin is running." });
    ws.close();
  });

  it("explains what's missing when there is no OpenAI key", async () => {
    const { setSetting } = await import("../utils/settings.js");
    setSetting("voice_live_enabled", "false");
    const ws = new WebSocket(relayUrl);
    await new Promise((resolve) => ws.addEventListener("open", resolve, { once: true }));
    const error = nextMessage(ws, "talome.error");
    ws.send(JSON.stringify({ type: "talome.start" }));
    expect((await error).message).toMatch(/OpenAI key/);
    setSetting("voice_live_enabled", "true");
  });
});
