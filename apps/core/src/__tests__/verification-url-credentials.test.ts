/**
 * An app URL saved with basic-auth credentials (http://user:pass@host) must
 * never put the password into verification evidence — which is persisted,
 * shown to members and handed to the AI. Node's fetch refuses such URLs and
 * echoes the full URL in its error message.
 */
import { describe, it, expect, vi, afterAll } from "vitest";
import { rmSync } from "node:fs";

vi.hoisted(() => {
  process.env.DATABASE_PATH = `${process.env.TMPDIR ?? "/tmp"}/talome-verification-url-creds-${process.pid}.db`;
});

afterAll(() => {
  for (const suffix of ["", "-wal", "-shm"]) rmSync(`${process.env.DATABASE_PATH}${suffix}`, { force: true });
});

vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("real network disabled in tests"); }));

import { verifyApp, type VerificationResult } from "../verification/index.js";
import { splitUrlCredentials, stripUrlCredentials } from "../verification/http.js";

const PASSWORD = "S3cretBasicPw";

interface Seen { url: string; headers: Record<string, string> }

/** Behaves like Node's fetch for URLs with credentials; otherwise answers via `respond`. */
function nodeLikeFetch(seen: Seen[], respond: (url: string, headers: Record<string, string>) => Response): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    seen.push({ url, headers });
    if (/^[a-z]+:\/\/[^/]*@/i.test(url)) {
      throw new TypeError(`Request cannot be constructed from a URL that includes credentials: ${url}`);
    }
    return respond(url, headers);
  }) as typeof fetch;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

async function run(appId: string, settings: Record<string, string>, fetchImpl: typeof fetch): Promise<VerificationResult> {
  const out = await verifyApp(appId, {
    persist: false,
    deps: {
      getSetting: (k) => settings[k],
      fetch: fetchImpl,
      inspectMounts: async () => null,
      lanAddress: () => undefined,
    },
  });
  if (!out.ok) throw new Error(out.error);
  return out.result;
}

describe("app URLs with basic-auth credentials", () => {
  it("never write the password into evidence (Home Assistant behind a basic-auth proxy)", async () => {
    const seen: Seen[] = [];
    const result = await run(
      "homeassistant",
      { homeassistant_url: `http://admin:${PASSWORD}@homeassistant.local:8123`, homeassistant_token: "hass-token-0123456789" },
      nodeLikeFetch(seen, () => json(502, { message: `upstream refused admin:${PASSWORD}` })),
    );
    const text = JSON.stringify(result);
    expect(text).not.toContain(PASSWORD);
    expect(text).not.toContain(encodeURIComponent(PASSWORD));
    // The request itself went to the URL without userinfo.
    expect(seen.length).toBeGreaterThan(0);
    for (const s of seen) expect(s.url).not.toContain("@");
  });

  it("send the credentials as HTTP Basic auth next to the app's own key", async () => {
    const seen: Seen[] = [];
    const expected = `Basic ${Buffer.from(`admin:${PASSWORD}`).toString("base64")}`;
    const result = await run(
      "sonarr",
      { sonarr_url: `http://admin:${PASSWORD}@sonarr:8989`, sonarr_api_key: "sonarr-key-0123456789abcdef" },
      nodeLikeFetch(seen, (_url, headers) =>
        headers.Authorization === expected ? json(200, { version: "4.0.0" }) : json(401, { message: "auth required" }),
      ),
    );
    const api = result.checks.find((c) => c.id === "api");
    expect(api?.status).toBe("pass");
    expect(seen[0]?.headers["X-Api-Key"]).toBe("sonarr-key-0123456789abcdef");
    expect(JSON.stringify(result)).not.toContain(PASSWORD);
  });

  it("strip userinfo from free text and split it from URLs", () => {
    expect(stripUrlCredentials(`Request cannot be constructed from a URL that includes credentials: http://admin:${PASSWORD}@ha.local:8123/api/`)).toBe(
      "Request cannot be constructed from a URL that includes credentials: http://ha.local:8123/api/",
    );
    expect(stripUrlCredentials("Failed to parse URL from http://admin:p@ss/w0rd@ha.local/")).not.toMatch(/p@ss|w0rd/);
    expect(splitUrlCredentials("http://ha.local:8123")).toEqual({ url: "http://ha.local:8123" });
    expect(splitUrlCredentials(`https://me:${encodeURIComponent("p@ss:w/rd")}@ha.local/x`)).toEqual({
      url: "https://ha.local/x",
      credentials: { username: "me", password: "p@ss:w/rd" },
    });
    expect(splitUrlCredentials("http://me:pa/ss@ha.local/")).toEqual({ url: "http://ha.local/", credentials: { username: "me", password: "pa/ss" } });
    // An "@" in the path of a URL without credentials is left alone.
    expect(splitUrlCredentials("http://ha.local/users/@me")).toEqual({ url: "http://ha.local/users/@me" });
  });
});
