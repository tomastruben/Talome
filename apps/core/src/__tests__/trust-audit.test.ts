import { describe, it, expect, beforeAll, vi } from "vitest";

vi.hoisted(() => {
  const dir = process.env.TMPDIR || "/tmp";
  process.env.DATABASE_PATH = `${dir}/talome-trust-audit-${process.pid}-${Date.now()}/talome.db`;
  process.env.TALOME_SECRET ||= "a".repeat(64);
});

vi.mock("../db/notifications.js", () => ({ writeNotification: vi.fn() }));

import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { runMigrations } from "../db/migrate.js";
import { setSetting } from "../utils/settings.js";
import { executeTool, type Actor } from "../ai/execution.js";
import { auditLog } from "../routes/audit-log.js";
import { invalidateSecretValueCache, redactValue, redactedPreview, REDACTED } from "../approval/redact.js";
import { FULL_ACCESS_SCOPES } from "../approval/grants.js";
import { writeAuditEntry } from "../db/audit.js";
import { registerFakeDomains } from "./helpers/trust-fixtures.js";

const SETTINGS_CANARY = "canary-sk-settings-7f3a9c1e5b";
const ARGS_CANARY = "canary-args-pw-2d8e4b6a0f";

const actor: Actor = { kind: "mcp_token", id: "tok-audit", label: "Audit token", scopes: FULL_ACCESS_SCOPES };

function allAuditText(): string {
  return JSON.stringify(db.select().from(schema.auditLog).all()) + JSON.stringify(db.select().from(schema.approvals).all());
}

beforeAll(() => {
  runMigrations();
  registerFakeDomains();
  setSetting("security_mode", "cautious");
  setSetting("sonarr_api_key", SETTINGS_CANARY);
  invalidateSecretValueCache();
});

describe("redaction", () => {
  it("redacts secret-looking keys and known secret values anywhere", () => {
    const out = redactValue(
      { password: "hunter2hunter2", nested: { apiKey: "x", api_key: "y", Authorization: "Bearer z", cookie: "c" }, cmd: `curl -H 'X-Api-Key: ${SETTINGS_CANARY}'`, plain: "ok" },
      [SETTINGS_CANARY],
    ) as Record<string, unknown>;
    expect(out.password).toBe(REDACTED);
    expect(out.nested).toEqual({ apiKey: REDACTED, api_key: REDACTED, Authorization: REDACTED, cookie: REDACTED });
    expect(out.cmd).toBe(`curl -H 'X-Api-Key: ${REDACTED}'`);
    expect(out.plain).toBe("ok");
  });

  it("truncates only after redaction, so no secret prefix leaks", () => {
    const preview = redactedPreview({ body: `${"x".repeat(20)}${SETTINGS_CANARY}` }, 30);
    expect(preview).not.toContain(SETTINGS_CANARY.slice(0, 8));
  });

  it("the settings secret is stored encrypted at rest", () => {
    const row = db.select().from(schema.settings).where(eq(schema.settings.key, "sonarr_api_key")).get();
    expect(row?.value).not.toContain(SETTINGS_CANARY);
  });
});

describe("audit log never contains secrets", () => {
  it("across success, error, blocked and approval_required outcomes", async () => {
    await executeTool({ actor, source: "mcp", toolName: "send_payload", args: { appId: "sonarr", body: `key=${SETTINGS_CANARY}`, password: ARGS_CANARY } });
    await executeTool({ actor, source: "mcp", toolName: "set_setting", args: { key: "radarr_api_key", value: SETTINGS_CANARY } });
    await executeTool({ actor, source: "mcp", toolName: "uninstall_app", args: { appId: SETTINGS_CANARY } });
    await executeTool({
      actor: { ...actor, scopes: { maxTier: "read", domains: "all", apps: "all" } },
      source: "mcp",
      toolName: "send_payload",
      args: { appId: "x", body: SETTINGS_CANARY, token: ARGS_CANARY },
    });
    await executeTool({ actor, source: "automation", toolName: "failing_tool", args: { secret: ARGS_CANARY } });

    const text = allAuditText();
    expect(text).not.toContain(SETTINGS_CANARY);
    expect(text).not.toContain(ARGS_CANARY);
    expect(text).toContain(REDACTED);

    const outcomes = new Set(db.select().from(schema.auditLog).all().map((e) => e.outcome));
    for (const o of ["success", "error", "blocked", "approval_required"]) expect(outcomes).toContain(o);
  });

  it("records actor, source, correct tier, outcome and duration", async () => {
    await executeTool({ actor, source: "mcp", toolName: "restart_app", args: { appId: "sonarr" } });
    const entry = db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.toolName, "restart_app"))
      .all()
      .at(-1);
    expect(entry).toMatchObject({
      action: "MCP: restart_app",
      tier: "modify",
      actorKind: "mcp_token",
      actorId: "tok-audit",
      actorLabel: "Audit token",
      source: "mcp",
      outcome: "success",
      approved: true,
    });
    expect(typeof entry?.durationMs).toBe("number");
    expect(entry?.details).toContain("sonarr");
  });

  it("the audit-log route returns the new columns and filters by actor", async () => {
    const app = new Hono().route("/audit", auditLog);
    const res = await app.request("/audit?actorId=tok-audit&outcome=success");
    const rows = (await res.json()) as Array<Record<string, unknown>>;
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.actorId).toBe("tok-audit");
      expect(r.outcome).toBe("success");
      expect(r).toHaveProperty("source");
      expect(r).toHaveProperty("durationMs");
    }
  });

  it("legacy writeAuditEntry callers keep working", () => {
    writeAuditEntry("Disk usage critical", "modify", "Disk at 97%");
    const e = db.select().from(schema.auditLog).where(eq(schema.auditLog.action, "Disk usage critical")).get();
    expect(e?.actorKind).toBeNull();
  });
});

describe("creator orchestrator key reader", () => {
  it("returns the decrypted anthropic_key, not the ciphertext", async () => {
    setSetting("anthropic_key", "sk-ant-canary-decrypt-check");
    const raw = db.select().from(schema.settings).where(eq(schema.settings.key, "anthropic_key")).get()?.value;
    expect(raw).not.toBe("sk-ant-canary-decrypt-check");
    const { getAnthropicApiKey } = await import("../creator/orchestrator.js");
    expect(getAnthropicApiKey()).toBe("sk-ant-canary-decrypt-check");
  });
});
