import { describe, it, expect, vi, afterAll } from "vitest";
import { rmSync } from "node:fs";

// Isolated sqlite file — never the real data dir.
vi.hoisted(() => {
  process.env.DATABASE_PATH = `${process.env.TMPDIR ?? "/tmp"}/talome-outcome-probes-framework-${process.pid}.db`;
});

afterAll(() => {
  for (const suffix of ["", "-wal", "-shm"]) rmSync(`${process.env.DATABASE_PATH}${suffix}`, { force: true });
});

import { createProbeEnv } from "../verification/env.js";
import { redactSecrets } from "../verification/redact.js";
import { aggregateStatus, runChecks, outcome, worstStatus, prefixChecks, type CheckDefinition } from "../verification/runner.js";
import { applyRemotePathMappings, isSameOrUnder, normalizePath, pathsOverlap, toHostPath } from "../verification/paths.js";
import type { CheckResult } from "../verification/types.js";

function env(settings: Record<string, string> = {}) {
  return createProbeEnv({
    getSetting: (k) => settings[k],
    fetch: (async () => { throw new Error("network disabled in tests"); }) as unknown as typeof fetch,
    inspectMounts: async () => null,
    lanAddress: () => undefined,
  });
}

function result(partial: Partial<CheckResult>): CheckResult {
  return { id: "x", label: "x", status: "pass", evidence: "", durationMs: 0, critical: false, active: false, ...partial };
}

describe("aggregateStatus", () => {
  it("is verified when every check that ran passed", () => {
    expect(aggregateStatus([result({ critical: true }), result({ id: "y" })])).toBe("verified");
  });
  it("is failed when a critical check fails or times out", () => {
    expect(aggregateStatus([result({ critical: true, status: "fail" }), result({ id: "y" })])).toBe("failed");
    expect(aggregateStatus([result({ critical: true, status: "timeout" })])).toBe("failed");
  });
  it("is degraded for non-critical failures, timeouts or warnings", () => {
    expect(aggregateStatus([result({ critical: true }), result({ id: "y", status: "warn" })])).toBe("degraded");
    expect(aggregateStatus([result({ critical: true }), result({ id: "y", status: "fail" })])).toBe("degraded");
    expect(aggregateStatus([result({ critical: true }), result({ id: "y", status: "timeout" })])).toBe("degraded");
  });
  it("is unknown when nothing ran or a critical check was skipped", () => {
    expect(aggregateStatus([result({ critical: true, status: "skip" })])).toBe("unknown");
    expect(aggregateStatus([])).toBe("unknown");
    expect(aggregateStatus([result({ critical: true, status: "skip" }), result({ id: "y" })])).toBe("unknown");
  });
  it("ignores skipped active probes", () => {
    expect(aggregateStatus([result({ critical: true }), result({ id: "a", status: "skip", active: true })])).toBe("verified");
  });
});

describe("runChecks", () => {
  it("skips active probes unless includeActive, and runs them when asked", async () => {
    const run = vi.fn(async () => outcome.pass("did it"));
    const defs: CheckDefinition[] = [{ id: "active", label: "Active", active: true, run }];
    const [skipped] = await runChecks(defs, env());
    expect(skipped.status).toBe("skip");
    expect(skipped.active).toBe(true);
    expect(run).not.toHaveBeenCalled();

    const [ran] = await runChecks(defs, env(), { includeActive: true });
    expect(ran.status).toBe("pass");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("skips dependents when a prerequisite fails", async () => {
    const dependent = vi.fn(async () => outcome.pass("unreachable"));
    const results = await runChecks([
      { id: "api", label: "API", critical: true, run: async () => outcome.fail("down") },
      { id: "libs", label: "Libraries", dependsOn: ["api"], run: dependent },
    ], env());
    expect(results.map((r) => r.status)).toEqual(["fail", "skip"]);
    expect(results[1].evidence).toContain("API");
    expect(dependent).not.toHaveBeenCalled();
  });

  it("times out a slow check, aborts its signal and records the duration", async () => {
    let aborted = false;
    const [r] = await runChecks([
      {
        id: "slow",
        label: "Slow",
        critical: true,
        timeoutMs: 30,
        run: (ctx) => new Promise((resolve) => {
          ctx.signal.addEventListener("abort", () => { aborted = true; });
          setTimeout(() => resolve(outcome.pass("too late")), 500);
        }),
      },
    ], env());
    expect(r.status).toBe("timeout");
    expect(r.evidence).toContain("30 ms");
    expect(aborted).toBe(true);
    expect(aggregateStatus([r])).toBe("failed");
  });

  it("turns a thrown error into a failed check instead of crashing", async () => {
    const [r] = await runChecks([{ id: "boom", label: "Boom", run: async () => { throw new Error("kaput"); } }], env());
    expect(r.status).toBe("fail");
    expect(r.evidence).toContain("kaput");
  });

  it("redacts every secret the probe environment read from evidence and remediation", async () => {
    const e = env({ sonarr_url: "http://sonarr:8989", sonarr_api_key: "super-secret-sonarr-key" });
    const [r] = await runChecks([
      {
        id: "leaky",
        label: "Leaky",
        run: async () => outcome.fail("upstream said apikey=super-secret-sonarr-key and Bearer abcdefghijkl", "use token: super-secret-sonarr-key"),
      },
    ], e);
    expect(JSON.stringify(r)).not.toContain("super-secret-sonarr-key");
    expect(r.evidence).toContain("[redacted]");
    expect(r.evidence).not.toContain("abcdefghijkl");
  });

  it("prefixes ids and dependencies for stack embedding", () => {
    const [a, b] = prefixChecks("sonarr", [
      { id: "api", label: "API", run: async () => outcome.pass("") },
      { id: "x", label: "X", dependsOn: ["api"], run: async () => outcome.pass("") },
    ], "sonarr");
    expect(a.id).toBe("sonarr:api");
    expect(b.dependsOn).toEqual(["sonarr:api"]);
    expect(b.appId).toBe("sonarr");
  });

  it("worstStatus orders fail > timeout > warn > pass > skip", () => {
    expect(worstStatus(["pass", "warn", "skip"])).toBe("warn");
    expect(worstStatus(["pass", "timeout"])).toBe("timeout");
    expect(worstStatus(["fail", "timeout"])).toBe("fail");
    expect(worstStatus([])).toBe("skip");
  });
});

describe("redactSecrets", () => {
  it("removes exact values, URL-encoded values and key=value patterns", () => {
    const secret = "p@ss word/123";
    const text = `a ${secret} b ${encodeURIComponent(secret)} c password=hunter22 X-Api-Key: abc123def MediaBrowser Token="tok-999"`;
    const out = redactSecrets(text, [secret]);
    expect(out).not.toContain(secret);
    expect(out).not.toContain(encodeURIComponent(secret));
    expect(out).not.toContain("hunter22");
    expect(out).not.toContain("abc123def");
    expect(out).not.toContain("tok-999");
  });
  it("leaves ordinary evidence alone", () => {
    expect(redactSecrets("Sonarr rejected the API key (HTTP 401).", ["zzzz"])).toBe("Sonarr rejected the API key (HTTP 401).");
  });
});

describe("path helpers", () => {
  it("normalizes and compares container paths", () => {
    expect(normalizePath("/downloads//tv/")).toBe("/downloads/tv");
    expect(isSameOrUnder("/data/media/tv", "/data/media")).toBe(true);
    expect(isSameOrUnder("/data/mediax", "/data/media")).toBe(false);
    expect(pathsOverlap("/data", "/data/media/tv")).toBe(true);
  });
  it("maps container paths to host paths via the longest mount", () => {
    const mounts = [
      { source: "/srv", destination: "/data" },
      { source: "/mnt/big/tv", destination: "/data/tv" },
    ];
    expect(toHostPath("/data/tv/Show", mounts)).toBe("/mnt/big/tv/Show");
    expect(toHostPath("/data/movies", mounts)).toBe("/srv/movies");
    expect(toHostPath("/config", mounts)).toBeNull();
    expect(toHostPath("/data", null)).toBeNull();
  });
  it("applies *arr remote path mappings", () => {
    const mapped = applyRemotePathMappings("/downloads/tv", [{ host: "qbittorrent", remotePath: "/downloads", localPath: "/data/downloads" }], "qbittorrent");
    expect(mapped.path).toBe("/data/downloads/tv");
    expect(applyRemotePathMappings("/downloads", [{ host: "other", remotePath: "/downloads", localPath: "/x" }], "qbittorrent").path).toBe("/downloads");
  });
});
