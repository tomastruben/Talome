import { describe, it, expect, vi, beforeEach } from "vitest";
import { z } from "zod";
import { timingSafeEqual } from "node:crypto";

// ═══════════════════════════════════════════════════════════════════════════════
// 1. Docker hostname validation (docker/client.ts)
// ═══════════════════════════════════════════════════════════════════════════════
//
// The DNS_RE regex and port validation live inside the private testPairConnectivity
// function. We extract the exact patterns here and test them directly.

describe("Docker hostname validation (DNS_RE)", () => {
  const DNS_RE = /^[a-zA-Z0-9._-]+$/;

  describe("valid hostnames", () => {
    it.each([
      "sonarr",
      "my-app",
      "app.local",
      "app_name",
      "My.Container-01",
      "a",
      "192.168.1.1",
    ])("accepts '%s'", (hostname) => {
      expect(DNS_RE.test(hostname)).toBe(true);
    });
  });

  describe("injection attempts rejected", () => {
    it.each([
      ["host;rm -rf /", "semicolon command injection"],
      ["host$(whoami)", "command substitution with $()"],
      ["host|cat /etc/passwd", "pipe injection"],
      ["host`id`", "backtick command substitution"],
      ["host\ninjected", "newline injection"],
      ["host && ls", "double-ampersand injection"],
      ["host > /dev/null", "redirect injection"],
      ["host\tinjected", "tab injection"],
      ["host name", "space in hostname"],
      ["", "empty string"],
    ])("rejects '%s' (%s)", (hostname) => {
      expect(DNS_RE.test(hostname)).toBe(false);
    });
  });

  describe("port validation", () => {
    function isValidPort(port: number): boolean {
      return port >= 1 && port <= 65535 && Number.isInteger(port);
    }

    it.each([80, 443, 8080, 8989, 1, 65535])("accepts port %d", (port) => {
      expect(isValidPort(port)).toBe(true);
    });

    it.each([
      [0, "zero"],
      [-1, "negative"],
      [65536, "above max"],
      [1.5, "fractional"],
      [NaN, "NaN"],
      [Infinity, "Infinity"],
      [-Infinity, "negative Infinity"],
    ])("rejects port %d (%s)", (port) => {
      expect(isValidPort(port)).toBe(false);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. Webhook timing-safe comparison (routes/webhooks.ts)
// ═══════════════════════════════════════════════════════════════════════════════
//
// The webhook route uses timingSafeEqual with padding logic to compare
// the x-webhook-signature header against the stored webhookSecret.

describe("Webhook timing-safe signature verification", () => {
  // Mirror the exact comparison logic from webhooks.ts lines 47-49
  function verifySignature(signature: string, expected: string): boolean {
    const sigBuf = Buffer.from(signature.padEnd(expected.length));
    const expBuf = Buffer.from(expected.padEnd(signature.length));
    if (sigBuf.length !== expBuf.length) return false;
    return timingSafeEqual(sigBuf, expBuf);
  }

  it("accepts a valid matching signature", () => {
    expect(verifySignature("my-secret-key", "my-secret-key")).toBe(true);
  });

  it("accepts an exact match for long secrets", () => {
    const secret = "a".repeat(256);
    expect(verifySignature(secret, secret)).toBe(true);
  });

  it("rejects an invalid signature", () => {
    expect(verifySignature("wrong-signature", "correct-secret")).toBe(false);
  });

  it("rejects an empty signature when secret is set", () => {
    expect(verifySignature("", "my-secret")).toBe(false);
  });

  it("handles shorter signature than expected (padding)", () => {
    // signature "ab" gets padded to length of expected "abcdef"
    // expected "abcdef" is already correct length
    // "ab    " !== "abcdef" — should fail
    expect(verifySignature("ab", "abcdef")).toBe(false);
  });

  it("handles longer signature than expected (padding)", () => {
    // signature "abcdef", expected "ab"
    // sigBuf = Buffer.from("abcdef") — length 6
    // expBuf = Buffer.from("ab    ") padded to 6 — length 6
    // "abcdef" !== "ab    " — should fail
    expect(verifySignature("abcdef", "ab")).toBe(false);
  });

  it("both buffers always end up the same length", () => {
    const sig = "short";
    const exp = "muchlongerstring";
    const sigBuf = Buffer.from(sig.padEnd(exp.length));
    const expBuf = Buffer.from(exp.padEnd(sig.length));
    expect(sigBuf.length).toBe(expBuf.length);
  });

  it("empty signature and empty expected both pass (no secret configured)", () => {
    // When there's no webhookSecret, the route skips verification entirely.
    // But if both are empty, the comparison itself would pass.
    expect(verifySignature("", "")).toBe(true);
  });

  it("rejects a signature that is a prefix of the secret", () => {
    expect(verifySignature("my-sec", "my-secret-key")).toBe(false);
  });

  it("rejects a signature that is a suffix of the secret", () => {
    expect(verifySignature("cret-key", "my-secret-key")).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. Custom tool filename validation (ai/custom-tools.ts)
// ═══════════════════════════════════════════════════════════════════════════════

describe("Custom tool filename validation", () => {
  // Mirrors the regex from createToolTool.execute: /^[a-z0-9_-]+\.ts$/
  const FILENAME_RE = /^[a-z0-9_-]+\.ts$/;

  describe("valid filenames", () => {
    it.each([
      "my-tool.ts",
      "weather.ts",
      "api_helper.ts",
      "a.ts",
      "tool-123.ts",
      "my_great-tool.ts",
    ])("accepts '%s'", (filename) => {
      expect(FILENAME_RE.test(filename)).toBe(true);
    });
  });

  describe("invalid filenames", () => {
    it.each([
      ["../escape.ts", "path traversal with .."],
      [".hidden.ts", "hidden file (leading dot)"],
      ["UPPER.ts", "uppercase letters"],
      ["has space.ts", "space in filename"],
      ["path/traversal.ts", "slash in filename"],
      ["no-ext", "missing .ts extension"],
      ["file.js", "wrong extension (.js)"],
      ["file.ts.ts", "double extension"],
      [".ts", "only extension, no name"],
      ["../../etc/passwd.ts", "deep path traversal"],
      ["file\x00.ts", "null byte injection"],
    ])("rejects '%s' (%s)", (filename) => {
      expect(FILENAME_RE.test(filename)).toBe(false);
    });
  });

  // Also requires .ts extension — test the separate check
  describe("extension guard", () => {
    it("requires .ts extension even if other validation passes", () => {
      const filename = "valid-name.js";
      expect(filename.endsWith(".ts")).toBe(false);
    });
  });
});

describe("Custom tool dangerous pattern detection (validateTypeScriptSyntax)", () => {
  // Mirrors the dangerous patterns array from custom-tools.ts
  const dangerousPatterns: Array<[RegExp, string]> = [
    [/process\.exit/, "process.exit()"],
    [/require\s*\(\s*['"]child_process['"]/, "require('child_process')"],
    [/from\s+['"]child_process['"]/, "from 'child_process'"],
    [/require\s*\(\s*['"]fs['"]/, "require('fs')"],
    [/from\s+['"]fs['"]/, "from 'fs'"],
    [/from\s+['"]node:fs['"]/, "from 'node:fs'"],
    [/from\s+['"]node:child_process['"]/, "from 'node:child_process'"],
    [/eval\s*\(/, "eval()"],
    [/Function\s*\(/, "Function()"],
    [/globalThis\s*\[/, "globalThis["],
    [/__proto__/, "__proto__"],
  ];

  function hasDangerousPattern(code: string): { blocked: boolean; reason?: string } {
    for (const [pattern, name] of dangerousPatterns) {
      if (pattern.test(code)) {
        return { blocked: true, reason: name };
      }
    }
    return { blocked: false };
  }

  describe("blocks dangerous code", () => {
    it("blocks eval()", () => {
      const code = `import { tool } from "ai"; export const t = tool({ execute: () => eval("alert(1)") });`;
      expect(hasDangerousPattern(code).blocked).toBe(true);
    });

    it("blocks Function() constructor", () => {
      const code = `const fn = Function("return this")();`;
      expect(hasDangerousPattern(code).blocked).toBe(true);
    });

    it("blocks require('child_process')", () => {
      const code = `const cp = require('child_process');`;
      expect(hasDangerousPattern(code).blocked).toBe(true);
    });

    it("blocks require(\"child_process\")", () => {
      const code = `const cp = require("child_process");`;
      expect(hasDangerousPattern(code).blocked).toBe(true);
    });

    it("blocks from 'fs'", () => {
      const code = `import { readFileSync } from 'fs';`;
      expect(hasDangerousPattern(code).blocked).toBe(true);
    });

    it("blocks from 'node:fs'", () => {
      const code = `import { readFile } from 'node:fs';`;
      expect(hasDangerousPattern(code).blocked).toBe(true);
    });

    it("blocks from 'child_process'", () => {
      const code = `import { exec } from 'child_process';`;
      expect(hasDangerousPattern(code).blocked).toBe(true);
    });

    it("blocks from 'node:child_process'", () => {
      const code = `import { spawn } from 'node:child_process';`;
      expect(hasDangerousPattern(code).blocked).toBe(true);
    });

    it("blocks globalThis[ dynamic access", () => {
      const code = `const val = globalThis["dangerous"];`;
      expect(hasDangerousPattern(code).blocked).toBe(true);
    });

    it("blocks globalThis[variable] access", () => {
      const code = `const key = "eval"; globalThis[key]("code");`;
      expect(hasDangerousPattern(code).blocked).toBe(true);
    });

    it("blocks __proto__ access", () => {
      const code = `obj.__proto__.polluted = true;`;
      expect(hasDangerousPattern(code).blocked).toBe(true);
    });

    it("blocks process.exit()", () => {
      const code = `process.exit(1);`;
      expect(hasDangerousPattern(code).blocked).toBe(true);
    });
  });

  describe("allows safe code", () => {
    it("allows normal tool code with fetch", () => {
      const code = `
import { tool } from "ai";
import { z } from "zod";
export const myTool = tool({
  description: "Fetch weather",
  inputSchema: z.object({ city: z.string() }),
  execute: async ({ city }) => {
    const res = await fetch(\`https://api.weather.com/\${city}\`);
    return res.json();
  },
});`;
      expect(hasDangerousPattern(code).blocked).toBe(false);
    });

    it("allows string containing 'eval' as substring (e.g. 'evaluation')", () => {
      // "evaluation" does NOT match /eval\s*\(/ because there's no opening paren
      const code = `const evaluation = "good";`;
      expect(hasDangerousPattern(code).blocked).toBe(false);
    });

    it("allows the word 'Function' in a comment without parens", () => {
      // "Function" without \s*( does not trigger
      const code = `// This is a Function reference doc\nconst x = 1;`;
      expect(hasDangerousPattern(code).blocked).toBe(false);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 4. Filesystem isAllowed with symlinks (utils/filesystem.ts)
// ═══════════════════════════════════════════════════════════════════════════════

// Mock dependencies required by filesystem.ts
vi.mock("../db/index.js", () => ({
  db: {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          get: vi.fn().mockReturnValue(null),
        }),
      }),
    }),
  },
  schema: {
    settings: { key: "key" },
  },
}));

// Mock settings to control getAllowedRoots
vi.mock("../utils/settings.js", () => ({
  getSetting: vi.fn().mockReturnValue(null),
}));

describe("Filesystem isAllowed path validation", () => {
  // We use real temp directories to test realpathSync behavior.
  // The isAllowed function relies on realpathSync + getAllowedRoots.

  // Since getAllowedRoots depends on CORE_ROOTS (which is ~/.talome) and
  // getSetting (mocked to null), it returns only CORE_ROOTS.
  // We test the path resolution logic by importing the actual module.

  let isAllowed: (absPath: string) => boolean;
  let TALOME_HOME: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    // Dynamic import to get the real module with mocked dependencies
    const fs = await import("../utils/filesystem.js");
    isAllowed = fs.isAllowed;
    TALOME_HOME = fs.TALOME_HOME;
  });

  it("allows paths within TALOME_HOME", () => {
    // TALOME_HOME is ~/.talome — a path within it should be allowed
    expect(isAllowed(`${TALOME_HOME}/custom-tools/my-tool.ts`)).toBe(true);
  });

  it("allows TALOME_HOME itself", () => {
    expect(isAllowed(TALOME_HOME)).toBe(true);
  });

  it("rejects paths outside allowed roots", () => {
    expect(isAllowed("/etc/passwd")).toBe(false);
  });

  it("rejects /tmp paths", () => {
    expect(isAllowed("/tmp/malicious-file")).toBe(false);
  });

  it("rejects root path", () => {
    expect(isAllowed("/")).toBe(false);
  });

  it("rejects path traversal with ../ that escapes the root", () => {
    // resolve() normalizes this to the parent, which would be outside the root
    expect(isAllowed(`${TALOME_HOME}/../../../etc/passwd`)).toBe(false);
  });

  it("allows path with ../ that stays within root", () => {
    // e.g., ~/.talome/sub/../other resolves to ~/.talome/other — still within root
    expect(isAllowed(`${TALOME_HOME}/sub/../custom-tools`)).toBe(true);
  });

  it("rejects path that looks like the root but escapes it", () => {
    // ~/.talome-evil should NOT match ~/.talome
    expect(isAllowed(`${TALOME_HOME}-evil/data`)).toBe(false);
  });

  it("rejects paths with null bytes", () => {
    // resolve() handles null bytes — the result should not be within allowed roots
    expect(isAllowed(`${TALOME_HOME}/\x00/../../etc/passwd`)).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 5. Automations Zod validation (routes/automations.ts)
// ═══════════════════════════════════════════════════════════════════════════════
//
// The automationCreateSchema is not exported, so we recreate it exactly as
// defined in the source file and test it directly.

describe("Automation create schema validation", () => {
  const automationTriggerSchema = z.object({
    type: z.string().min(1, "trigger.type is required"),
    webhookSecret: z.string().optional(),
    cron: z.string().optional(),
    event: z.string().optional(),
  }).passthrough();

  const automationCreateSchema = z.object({
    name: z.string().min(1, "name is required").max(200),
    trigger: automationTriggerSchema,
    conditions: z.array(z.object({
      field: z.string().regex(/^[a-zA-Z0-9_.]+$/, "field must be alphanumeric with dots/underscores only"),
      operator: z.enum(["eq", "gt", "lt", "contains"]),
      value: z.unknown(),
    })).max(20).default([]),
    actions: z.array(z.unknown()).max(50).optional(),
    steps: z.array(z.unknown()).max(50).optional(),
    enabled: z.boolean().default(true),
  });

  describe("valid inputs", () => {
    it("accepts a minimal valid automation with actions", () => {
      const result = automationCreateSchema.safeParse({
        name: "My Automation",
        trigger: { type: "webhook" },
        actions: [{ type: "notify", title: "Hello" }],
      });
      expect(result.success).toBe(true);
    });

    it("accepts an automation with steps (v2)", () => {
      const result = automationCreateSchema.safeParse({
        name: "V2 Workflow",
        trigger: { type: "cron", cron: "0 * * * *" },
        steps: [{ id: "step1", type: "notify", title: "Test" }],
      });
      expect(result.success).toBe(true);
    });

    it("accepts conditions with valid field names", () => {
      const result = automationCreateSchema.safeParse({
        name: "Conditional",
        trigger: { type: "event", event: "container.start" },
        conditions: [
          { field: "container.status", operator: "eq", value: "running" },
          { field: "cpu_usage", operator: "gt", value: 80 },
        ],
        actions: [{ type: "notify" }],
      });
      expect(result.success).toBe(true);
    });

    it("accepts a trigger with webhookSecret", () => {
      const result = automationCreateSchema.safeParse({
        name: "Webhook with secret",
        trigger: { type: "webhook", webhookSecret: "super-secret-123" },
        actions: [{ type: "notify" }],
      });
      expect(result.success).toBe(true);
    });

    it("defaults enabled to true when not specified", () => {
      const result = automationCreateSchema.safeParse({
        name: "Auto-enabled",
        trigger: { type: "webhook" },
        actions: [{ type: "notify" }],
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.enabled).toBe(true);
      }
    });

    it("defaults conditions to empty array when not specified", () => {
      const result = automationCreateSchema.safeParse({
        name: "No conditions",
        trigger: { type: "cron" },
        actions: [{ type: "notify" }],
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.conditions).toEqual([]);
      }
    });
  });

  describe("invalid inputs", () => {
    it("rejects empty name", () => {
      const result = automationCreateSchema.safeParse({
        name: "",
        trigger: { type: "webhook" },
        actions: [{ type: "notify" }],
      });
      expect(result.success).toBe(false);
    });

    it("rejects name over 200 characters", () => {
      const result = automationCreateSchema.safeParse({
        name: "x".repeat(201),
        trigger: { type: "webhook" },
        actions: [{ type: "notify" }],
      });
      expect(result.success).toBe(false);
    });

    it("accepts name at exactly 200 characters", () => {
      const result = automationCreateSchema.safeParse({
        name: "x".repeat(200),
        trigger: { type: "webhook" },
        actions: [{ type: "notify" }],
      });
      expect(result.success).toBe(true);
    });

    it("rejects missing trigger type", () => {
      const result = automationCreateSchema.safeParse({
        name: "No trigger type",
        trigger: {},
        actions: [{ type: "notify" }],
      });
      expect(result.success).toBe(false);
    });

    it("rejects empty trigger type", () => {
      const result = automationCreateSchema.safeParse({
        name: "Empty trigger",
        trigger: { type: "" },
        actions: [{ type: "notify" }],
      });
      expect(result.success).toBe(false);
    });

    it("rejects missing trigger entirely", () => {
      const result = automationCreateSchema.safeParse({
        name: "No trigger",
        actions: [{ type: "notify" }],
      });
      expect(result.success).toBe(false);
    });
  });

  describe("condition field injection protection", () => {
    it("allows __proto__ through field regex (only blocks special chars, not keywords)", () => {
      // Note: __proto__ matches /^[a-zA-Z0-9_.]+$/ because it only contains
      // underscores and letters. The regex is designed to block shell/injection
      // chars (;, $, [], etc.), not specific JS keywords. Prototype pollution
      // must be mitigated at the runtime level, not by field name validation alone.
      const result = automationCreateSchema.safeParse({
        name: "Proto field",
        trigger: { type: "webhook" },
        conditions: [
          { field: "__proto__", operator: "eq", value: "polluted" },
        ],
        actions: [{ type: "notify" }],
      });
      expect(result.success).toBe(true);
    });

    it("allows constructor.prototype through field regex (alphanumeric with dots)", () => {
      const result = automationCreateSchema.safeParse({
        name: "Constructor injection",
        trigger: { type: "webhook" },
        conditions: [
          { field: "constructor.prototype", operator: "eq", value: "x" },
        ],
        actions: [{ type: "notify" }],
      });
      // "constructor.prototype" contains only valid chars [a-zA-Z0-9_.]
      // The regex blocks injection operators, not prototype names.
      expect(result.success).toBe(true);
    });

    it("rejects field names with semicolons", () => {
      const result = automationCreateSchema.safeParse({
        name: "Semicolon injection",
        trigger: { type: "webhook" },
        conditions: [
          { field: "field;DROP TABLE", operator: "eq", value: 1 },
        ],
        actions: [{ type: "notify" }],
      });
      expect(result.success).toBe(false);
    });

    it("rejects field names with brackets", () => {
      const result = automationCreateSchema.safeParse({
        name: "Bracket injection",
        trigger: { type: "webhook" },
        conditions: [
          { field: "obj[key]", operator: "eq", value: 1 },
        ],
        actions: [{ type: "notify" }],
      });
      expect(result.success).toBe(false);
    });

    it("rejects field names with spaces", () => {
      const result = automationCreateSchema.safeParse({
        name: "Space injection",
        trigger: { type: "webhook" },
        conditions: [
          { field: "field name", operator: "eq", value: 1 },
        ],
        actions: [{ type: "notify" }],
      });
      expect(result.success).toBe(false);
    });

    it("rejects field names with dollar signs", () => {
      const result = automationCreateSchema.safeParse({
        name: "Dollar injection",
        trigger: { type: "webhook" },
        conditions: [
          { field: "$where", operator: "eq", value: 1 },
        ],
        actions: [{ type: "notify" }],
      });
      expect(result.success).toBe(false);
    });

    it("rejects field names with hyphens", () => {
      const result = automationCreateSchema.safeParse({
        name: "Hyphen field",
        trigger: { type: "webhook" },
        conditions: [
          { field: "some-field", operator: "eq", value: 1 },
        ],
        actions: [{ type: "notify" }],
      });
      expect(result.success).toBe(false);
    });

    it("rejects invalid operator", () => {
      const result = automationCreateSchema.safeParse({
        name: "Bad operator",
        trigger: { type: "webhook" },
        conditions: [
          { field: "status", operator: "exec", value: 1 },
        ],
        actions: [{ type: "notify" }],
      });
      expect(result.success).toBe(false);
    });
  });

  describe("array size limits", () => {
    it("rejects more than 20 conditions", () => {
      const conditions = Array.from({ length: 21 }, (_, i) => ({
        field: `field${i}`,
        operator: "eq" as const,
        value: i,
      }));
      const result = automationCreateSchema.safeParse({
        name: "Too many conditions",
        trigger: { type: "webhook" },
        conditions,
        actions: [{ type: "notify" }],
      });
      expect(result.success).toBe(false);
    });

    it("accepts exactly 20 conditions", () => {
      const conditions = Array.from({ length: 20 }, (_, i) => ({
        field: `field${i}`,
        operator: "eq" as const,
        value: i,
      }));
      const result = automationCreateSchema.safeParse({
        name: "Max conditions",
        trigger: { type: "webhook" },
        conditions,
        actions: [{ type: "notify" }],
      });
      expect(result.success).toBe(true);
    });

    it("rejects more than 50 steps", () => {
      const steps = Array.from({ length: 51 }, (_, i) => ({
        id: `step${i}`,
        type: "notify",
      }));
      const result = automationCreateSchema.safeParse({
        name: "Too many steps",
        trigger: { type: "webhook" },
        steps,
      });
      expect(result.success).toBe(false);
    });

    it("accepts exactly 50 steps", () => {
      const steps = Array.from({ length: 50 }, (_, i) => ({
        id: `step${i}`,
        type: "notify",
      }));
      const result = automationCreateSchema.safeParse({
        name: "Max steps",
        trigger: { type: "webhook" },
        steps,
      });
      expect(result.success).toBe(true);
    });

    it("rejects more than 50 actions", () => {
      const actions = Array.from({ length: 51 }, (_, i) => ({
        type: "notify",
        title: `Action ${i}`,
      }));
      const result = automationCreateSchema.safeParse({
        name: "Too many actions",
        trigger: { type: "webhook" },
        actions,
      });
      expect(result.success).toBe(false);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 6. URL building (ai/tools/universal-tools.ts)
// ═══════════════════════════════════════════════════════════════════════════════
//
// buildUrl is a private function, so we recreate its exact logic and test it.

describe("URL building (buildUrl)", () => {
  type AuthStyle =
    | { type: "x-api-key"; header: string; value: string }
    | { type: "bearer"; header: string; value: string }
    | { type: "mediabrowser"; header: string; value: string }
    | { type: "query"; param: string; value: string }
    | { type: "none" };

  function buildUrl(base: string, path: string, auth: AuthStyle): string {
    const url = `${base}${path.startsWith("/") ? path : `/${path}`}`;
    if (auth.type === "query") {
      const parsed = new URL(url);
      parsed.searchParams.set(auth.param, auth.value);
      return parsed.toString();
    }
    return url;
  }

  it("concatenates base URL and absolute path", () => {
    const url = buildUrl("http://localhost:8989", "/api/v3/status", { type: "none" });
    expect(url).toBe("http://localhost:8989/api/v3/status");
  });

  it("adds leading slash to relative paths", () => {
    const url = buildUrl("http://localhost:8989", "api/v3/status", { type: "none" });
    expect(url).toBe("http://localhost:8989/api/v3/status");
  });

  it("appends query param for query auth type", () => {
    const url = buildUrl("http://localhost:4865", "/admin/api.php", {
      type: "query",
      param: "auth",
      value: "my-token-123",
    });
    expect(url).toContain("auth=my-token-123");
  });

  it("does not add query params for non-query auth types", () => {
    const url = buildUrl("http://localhost:8989", "/api/v3/status", {
      type: "x-api-key",
      header: "X-Api-Key",
      value: "secret",
    });
    expect(url).not.toContain("?");
    expect(url).toBe("http://localhost:8989/api/v3/status");
  });

  describe("special character encoding in query params", () => {
    it("encodes spaces in auth value", () => {
      const url = buildUrl("http://localhost:4865", "/admin/api.php", {
        type: "query",
        param: "auth",
        value: "token with spaces",
      });
      // URLSearchParams encodes spaces as '+'
      expect(url).toContain("auth=token+with+spaces");
    });

    it("encodes ampersands in auth value", () => {
      const url = buildUrl("http://localhost:4865", "/api", {
        type: "query",
        param: "key",
        value: "a&b=c",
      });
      // URLSearchParams encodes & as %26 and = as %3D
      const parsed = new URL(url);
      expect(parsed.searchParams.get("key")).toBe("a&b=c");
      // The raw URL should not have a raw & in the value
      expect(url).not.toMatch(/key=a&b/);
    });

    it("encodes angle brackets in auth value", () => {
      const url = buildUrl("http://localhost:4865", "/api", {
        type: "query",
        param: "key",
        value: "<script>alert(1)</script>",
      });
      const parsed = new URL(url);
      expect(parsed.searchParams.get("key")).toBe("<script>alert(1)</script>");
    });

    it("preserves existing query params in the path", () => {
      const url = buildUrl("http://localhost:4865", "/api?existing=true", {
        type: "query",
        param: "auth",
        value: "token",
      });
      const parsed = new URL(url);
      expect(parsed.searchParams.get("existing")).toBe("true");
      expect(parsed.searchParams.get("auth")).toBe("token");
    });

    it("encodes unicode characters in auth value", () => {
      const url = buildUrl("http://localhost:4865", "/api", {
        type: "query",
        param: "key",
        value: "token\u00e9\u00fc",
      });
      const parsed = new URL(url);
      expect(parsed.searchParams.get("key")).toBe("token\u00e9\u00fc");
    });

    it("handles hash fragments correctly", () => {
      const url = buildUrl("http://localhost:4865", "/api#fragment", {
        type: "query",
        param: "auth",
        value: "token",
      });
      const parsed = new URL(url);
      expect(parsed.searchParams.get("auth")).toBe("token");
    });
  });
});
