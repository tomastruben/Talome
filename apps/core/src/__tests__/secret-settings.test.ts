import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

// A real SQLite file with encryption enabled — must be set before db/index.js loads.
const tempDir = mkdtempSync(join(tmpdir(), "talome-secret-settings-"));
process.env.DATABASE_PATH = join(tempDir, "talome.db");
process.env.TALOME_SECRET = "a".repeat(64);

const SRC_ROOT = join(import.meta.dirname, "..");

function listSourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return entry === "__tests__" ? [] : listSourceFiles(path);
    return path.endsWith(".ts") ? [path] : [];
  });
}

describe("secret settings are decrypted on read", () => {
  let db: typeof import("../db/index.js")["db"];
  let schema: typeof import("../db/index.js")["schema"];
  let setSetting: typeof import("../utils/settings.js")["setSetting"];
  let getAnthropicApiKey: typeof import("../creator/orchestrator.js")["getAnthropicApiKey"];

  beforeAll(async () => {
    ({ db, schema } = await import("../db/index.js"));
    const { runMigrations } = await import("../db/migrate.js");
    runMigrations();
    ({ setSetting } = await import("../utils/settings.js"));
    ({ getAnthropicApiKey } = await import("../creator/orchestrator.js"));
  });

  afterAll(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("stores anthropic_key encrypted and returns it decrypted", async () => {
    const { eq } = await import("drizzle-orm");
    const previousEnvKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      setSetting("anthropic_key", "sk-ant-test-canary");

      const raw = db.select().from(schema.settings).where(eq(schema.settings.key, "anthropic_key")).get();
      expect(raw?.value).toBeDefined();
      expect(raw?.value).not.toContain("sk-ant-test-canary");

      expect(getAnthropicApiKey()).toBe("sk-ant-test-canary");
    } finally {
      if (previousEnvKey !== undefined) process.env.ANTHROPIC_API_KEY = previousEnvKey;
    }
  });

  it("no source file reads a secret setting straight from the settings table", () => {
    // Secret keys end in these suffixes (see isSecretSettingKey). Reading them with a raw
    // `schema.settings.key, "<name>_key"` query skips decryption — use getSetting() instead.
    const rawSecretRead = /settings\.key,\s*"[a-z0-9_]+(?:_api_key|_key|_token|_secret|_password)"/;
    const offenders = listSourceFiles(SRC_ROOT)
      .filter((file) => rawSecretRead.test(readFileSync(file, "utf8")))
      .map((file) => relative(SRC_ROOT, file));

    expect(offenders).toEqual([]);
  });
});
