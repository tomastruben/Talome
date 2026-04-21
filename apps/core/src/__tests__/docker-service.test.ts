import { describe, it, expect, vi } from "vitest";
import { homedir } from "node:os";
import { join } from "node:path";

// ── Mock DB so the module loads without a real SQLite connection ──────────────
vi.mock("../db/index.js", () => ({
  db: {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          orderBy: vi.fn().mockReturnValue({
            limit: vi.fn().mockReturnValue({
              all: vi.fn().mockReturnValue([]),
              get: vi.fn().mockReturnValue(undefined),
            }),
          }),
          all: vi.fn().mockReturnValue([]),
          get: vi.fn().mockReturnValue(undefined),
        }),
      }),
    }),
  },
  schema: {
    installErrors: {},
    containerEvents: {},
  },
}));

import { parseMissingVariables } from "../services/docker.js";

// ── parseMissingVariables ────────────────────────────────────────────────────

describe("parseMissingVariables", () => {
  it("parses 'The \"VAR\" variable is not set' pattern", () => {
    const stderr = `The "UMBREL_ROOT" variable is not set. Defaulting to a blank string.`;
    const result = parseMissingVariables(stderr);

    expect(result).toHaveLength(1);
    expect(result[0].errorType).toBe("missing_env_variable");
    expect(result[0].variable).toBe("UMBREL_ROOT");
    expect(result[0].suggestion).toContain("UMBREL_ROOT");
    expect(result[0].suggestion).toContain(".talome");
    expect(result[0].displayMessage).toContain("Missing environment variable: UMBREL_ROOT");
  });

  it("parses 'variable \"VAR\" is not set' pattern", () => {
    const stderr = `variable "DB_PASSWORD" is not set and no default value`;
    const result = parseMissingVariables(stderr);

    expect(result).toHaveLength(1);
    expect(result[0].variable).toBe("DB_PASSWORD");
    expect(result[0].suggestion).toContain("DB_PASSWORD");
  });

  it("parses WARN format from Docker Compose v2", () => {
    const stderr = `WARN[0000]  The "DEVI" variable is not set. Defaulting to a blank string.\nWARN[0000]  The "APP_PORT" variable is not set. Defaulting to a blank string.`;
    const result = parseMissingVariables(stderr);

    expect(result).toHaveLength(2);
    expect(result[0].variable).toBe("DEVI");
    expect(result[0].suggestion).toContain("typo");
    expect(result[1].variable).toBe("APP_PORT");
  });

  it("parses 'invalid interpolation format' pattern", () => {
    const stderr = `invalid interpolation format for services.app.environment.BROKEN_VAR: "required"`;
    const result = parseMissingVariables(stderr);

    expect(result).toHaveLength(1);
    expect(result[0].variable).toBe("services.app.environment.BROKEN_VAR");
  });

  it("deduplicates variables across patterns", () => {
    const stderr = [
      `The "MY_VAR" variable is not set. Defaulting to a blank string.`,
      `WARN[0000]  The "MY_VAR" variable is not set. Defaulting to a blank string.`,
    ].join("\n");
    const result = parseMissingVariables(stderr);

    expect(result).toHaveLength(1);
    expect(result[0].variable).toBe("MY_VAR");
  });

  it("extracts multiple variables from a single stderr", () => {
    const stderr = [
      `The "VAR_A" variable is not set. Defaulting to a blank string.`,
      `The "VAR_B" variable is not set. Defaulting to a blank string.`,
      `variable "VAR_C" is not set and no default value`,
    ].join("\n");
    const result = parseMissingVariables(stderr);

    expect(result).toHaveLength(3);
    const names = result.map((v) => v.variable);
    expect(names).toEqual(["VAR_A", "VAR_B", "VAR_C"]);
  });

  it("extracts line reference from stderr", () => {
    const stderr = `yaml: line 42: The "FOO" variable is not set`;
    const result = parseMissingVariables(stderr);

    expect(result).toHaveLength(1);
    expect(result[0].line).toBe("42");
    expect(result[0].suggestion).toContain("line 42");
  });

  it("extracts compose file path from stderr", () => {
    const stderr = `Error in /home/user/apps/my-app/docker-compose.yml: The "SECRET" variable is not set`;
    const result = parseMissingVariables(stderr);

    expect(result).toHaveLength(1);
    expect(result[0].composePath).toBe("/home/user/apps/my-app/docker-compose.yml");
  });

  it("uses opts.line and opts.composePath when provided", () => {
    const stderr = `The "CUSTOM" variable is not set`;
    const result = parseMissingVariables(stderr, {
      line: "10",
      composePath: "/opt/app/compose.yml",
    });

    expect(result).toHaveLength(1);
    expect(result[0].line).toBe("10");
    expect(result[0].composePath).toBe("/opt/app/compose.yml");
    expect(result[0].expectedIn).toContain("/opt/app/compose.yml");
    expect(result[0].expectedIn).toContain("10");
  });

  it("returns empty array when no variable errors found", () => {
    const stderr = `Error: port 8080 is already allocated`;
    const result = parseMissingVariables(stderr);

    expect(result).toHaveLength(0);
  });

  it("returns empty array for empty stderr", () => {
    expect(parseMissingVariables("")).toHaveLength(0);
  });

  it("generates UMBREL_ROOT suggestion with dynamic homedir", () => {
    const stderr = `The "UMBREL_ROOT" variable is not set`;
    const result = parseMissingVariables(stderr);

    // The suggestion should use the actual homedir
    const expectedPath = join(homedir(), ".talome");
    expect(result[0].suggestion).toContain(`UMBREL_ROOT=${expectedPath}`);
    expect(result[0].suggestion).toContain(".env file");
  });

  it("marks DEVI-like variables as potential typos", () => {
    const stderr = `The "DEVI" variable is not set`;
    const result = parseMissingVariables(stderr);

    expect(result[0].variable).toBe("DEVI");
    expect(result[0].suggestion).toContain("typo");
    expect(result[0].suggestion).toContain("misspelling");
  });

  it("handles real-world Umbrel compose stderr", () => {
    const stderr = [
      `WARN[0000]  The "UMBREL_ROOT" variable is not set. Defaulting to a blank string.`,
      `WARN[0000]  The "APP_DOMAIN" variable is not set. Defaulting to a blank string.`,
      `service "web" has neither an image nor a build context specified: invalid compose project`,
    ].join("\n");
    const result = parseMissingVariables(stderr);

    expect(result).toHaveLength(2);
    expect(result[0].variable).toBe("UMBREL_ROOT");
    expect(result[1].variable).toBe("APP_DOMAIN");

    // All results have required fields
    for (const v of result) {
      expect(v.errorType).toBe("missing_env_variable");
      expect(v.displayMessage).toBeTruthy();
      expect(v.suggestion).toBeTruthy();
    }
  });

  it("extracts file:line references like compose.yml:15", () => {
    const stderr = `Error parsing compose.yml:15 — variable "PORT" is not set`;
    const result = parseMissingVariables(stderr);

    expect(result).toHaveLength(1);
    expect(result[0].line).toBe("15");
  });
});
