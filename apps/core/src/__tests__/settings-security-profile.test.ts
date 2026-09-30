import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { rmSync } from "node:fs";

const { tempDir } = vi.hoisted(() => {
  const dir = `${process.cwd()}/data/test-security-profile-${process.pid}-${Date.now()}`;
  process.env.DATABASE_PATH = `${dir}/talome.db`;
  return { tempDir: dir };
});

import { db } from "../db/index.js";
import { runMigrations } from "../db/migrate.js";
import { settings } from "../routes/settings.js";
import { SHELL_ALLOWLIST } from "../ai/tools/shell-tool.js";
import { setSetting } from "../utils/settings.js";

beforeAll(() => runMigrations());
afterAll(() => {
  delete process.env.DATABASE_PATH;
  try { db.$client.close(); } catch { /* already closed */ }
  rmSync(tempDir, { recursive: true, force: true });
});

describe("GET /api/settings/security-profile (P0-10)", () => {
  it("reports what core enforces: mode, the real shell allowlist and approval lifetimes", async () => {
    const res = await settings.request("/security-profile");
    expect(res.status).toBe(200);
    const body = await res.json() as {
      mode: string;
      shellAllowlist: string[];
      approvalTtlMinutes: { interactive: number; unattended: number };
      claudeCode: { buildsSkipPrompts: boolean; evolutionSkipsPrompts: boolean };
    };
    expect(body.mode).toBe("cautious");
    expect(body.shellAllowlist).toEqual([...SHELL_ALLOWLIST].sort());
    // The dashboard used to list these although core refuses them.
    for (const refused of ["docker", "curl", "mv"]) expect(body.shellAllowlist).not.toContain(refused);
    expect(body.approvalTtlMinutes).toEqual({ interactive: 15, unattended: 1440 });
    expect(body.claudeCode).toEqual({ buildsSkipPrompts: false, evolutionSkipsPrompts: false });
  });

  it("reflects the owner's permission-prompt choices", async () => {
    setSetting("creator_skip_permission_prompts", "true");
    setSetting("security_mode", "locked");
    const body = await (await settings.request("/security-profile")).json() as {
      mode: string;
      claudeCode: { buildsSkipPrompts: boolean; evolutionSkipsPrompts: boolean };
    };
    expect(body.mode).toBe("locked");
    expect(body.claudeCode).toEqual({ buildsSkipPrompts: true, evolutionSkipsPrompts: false });
  });
});
