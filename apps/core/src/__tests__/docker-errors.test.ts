import { describe, it, expect } from "vitest";
import { parseMissingVariables, type MissingVariable } from "../services/docker.js";

describe("parseMissingVariables", () => {
  it("extracts UMBREL_ROOT from 'variable is not set' pattern", () => {
    const stderr = `WARN[0000] The "UMBREL_ROOT" variable is not set. Defaulting to a blank string.`;
    const result = parseMissingVariables(stderr);

    expect(result).toHaveLength(1);
    expect(result[0].errorType).toBe("missing_env_variable");
    expect(result[0].variable).toBe("UMBREL_ROOT");
    expect(result[0].suggestion).toContain("UMBREL_ROOT=");
    expect(result[0].suggestion).toContain(".talome");
    expect(result[0].displayMessage).toContain("Missing environment variable: UMBREL_ROOT");
  });

  it("extracts DEVI as likely typo", () => {
    const stderr = `The "DEVI" variable is not set. Defaulting to a blank string.`;
    const result = parseMissingVariables(stderr);

    expect(result).toHaveLength(1);
    expect(result[0].variable).toBe("DEVI");
    expect(result[0].suggestion).toContain("typo");
    expect(result[0].displayMessage).toContain("Missing environment variable: DEVI");
  });

  it("extracts multiple missing variables", () => {
    const stderr = [
      `WARN[0000] The "UMBREL_ROOT" variable is not set. Defaulting to a blank string.`,
      `WARN[0000] The "DEVI" variable is not set. Defaulting to a blank string.`,
      `WARN[0000] The "APP_PORT" variable is not set. Defaulting to a blank string.`,
    ].join("\n");

    const result = parseMissingVariables(stderr);

    expect(result).toHaveLength(3);
    expect(result.map((v: MissingVariable) => v.variable)).toEqual(["UMBREL_ROOT", "DEVI", "APP_PORT"]);
    result.forEach((v: MissingVariable) => expect(v.errorType).toBe("missing_env_variable"));
  });

  it("handles 'variable is not set and no default value' pattern", () => {
    const stderr = `variable "MY_SECRET" is not set and no default value`;
    const result = parseMissingVariables(stderr);

    expect(result).toHaveLength(1);
    expect(result[0].variable).toBe("MY_SECRET");
    expect(result[0].suggestion).toContain("MY_SECRET");
  });

  it("handles invalid interpolation format", () => {
    const stderr = `invalid interpolation format for APP_KEY: required format is \${VAR}`;
    const result = parseMissingVariables(stderr);

    expect(result).toHaveLength(1);
    expect(result[0].variable).toBe("APP_KEY");
  });

  it("deduplicates variables across patterns", () => {
    const stderr = [
      `The "FOO" variable is not set`,
      `variable "FOO" is not set and no default value`,
      `WARN[0000] The "FOO" variable is not set. Defaulting to a blank string.`,
    ].join("\n");

    const result = parseMissingVariables(stderr);
    expect(result).toHaveLength(1);
    expect(result[0].variable).toBe("FOO");
  });

  it("extracts line reference from stderr", () => {
    const stderr = `Error on line 42: The "DB_HOST" variable is not set`;
    const result = parseMissingVariables(stderr);

    expect(result).toHaveLength(1);
    expect(result[0].line).toBe("42");
    expect(result[0].suggestion).toContain("line 42");
  });

  it("extracts compose file path from stderr", () => {
    const stderr = `Error in /home/user/apps/docker-compose.yml: The "API_KEY" variable is not set`;
    const result = parseMissingVariables(stderr);

    expect(result).toHaveLength(1);
    expect(result[0].composePath).toBe("/home/user/apps/docker-compose.yml");
  });

  it("uses opts.line and opts.composePath when provided", () => {
    const stderr = `The "TOKEN" variable is not set`;
    const result = parseMissingVariables(stderr, {
      line: "15",
      composePath: "/app/docker-compose.yml",
    });

    expect(result).toHaveLength(1);
    expect(result[0].line).toBe("15");
    expect(result[0].composePath).toBe("/app/docker-compose.yml");
    expect(result[0].expectedIn).toContain("/app/docker-compose.yml:15");
  });

  it("returns empty array for non-variable errors", () => {
    const stderr = `Error: port 8080 is already allocated`;
    const result = parseMissingVariables(stderr);
    expect(result).toHaveLength(0);
  });

  it("UMBREL_ROOT expectedIn mentions Umbrel-format apps", () => {
    const stderr = `The "UMBREL_ROOT" variable is not set`;
    const result = parseMissingVariables(stderr, {
      composePath: "/home/user/umbrel-app/docker-compose.yml",
    });

    expect(result[0].expectedIn).toContain("Umbrel-format apps");
    expect(result[0].expectedIn).toContain("/home/user/umbrel-app/docker-compose.yml");
  });

  it("DEV-prefixed variables are flagged as potential typos", () => {
    const stderr = `The "DEVID" variable is not set`;
    const result = parseMissingVariables(stderr);

    expect(result[0].suggestion).toContain("typo");
  });
});

describe("parseMissingVariables — structured error shape", () => {
  it("produces a complete MissingVariable object for UMBREL_ROOT", () => {
    const stderr = [
      `WARN[0000] The "UMBREL_ROOT" variable is not set. Defaulting to a blank string.`,
      `WARN[0000] The "APP_PORT" variable is not set. Defaulting to a blank string.`,
    ].join("\n");

    const result = parseMissingVariables(stderr, {
      composePath: "/home/user/.talome/app-data/my-app/docker-compose.yml",
      line: "18",
    });

    expect(result).toHaveLength(2);

    // UMBREL_ROOT gets a specialized suggestion
    const umbrel = result[0];
    expect(umbrel).toMatchObject({
      errorType: "missing_env_variable",
      variable: "UMBREL_ROOT",
      line: "18",
      composePath: "/home/user/.talome/app-data/my-app/docker-compose.yml",
    });
    expect(umbrel.suggestion).toContain("UMBREL_ROOT=");
    expect(umbrel.suggestion).toContain(".talome");
    expect(umbrel.displayMessage).toBe(
      `Missing environment variable: UMBREL_ROOT — ${umbrel.suggestion}`,
    );
    expect(umbrel.expectedIn).toContain("Umbrel-format apps");

    // APP_PORT gets a generic suggestion
    const appPort = result[1];
    expect(appPort).toMatchObject({
      errorType: "missing_env_variable",
      variable: "APP_PORT",
      line: "18",
      composePath: "/home/user/.talome/app-data/my-app/docker-compose.yml",
    });
    expect(appPort.suggestion).toContain("APP_PORT");
    expect(appPort.suggestion).toContain("line 18");
  });

  it("parses realistic docker compose v2 stderr with mixed warnings and errors", () => {
    const stderr = [
      `WARN[0000] The "UMBREL_ROOT" variable is not set. Defaulting to a blank string.`,
      `WARN[0000] The "DEVI" variable is not set. Defaulting to a blank string.`,
      `WARN[0000] The "APP_PASSWORD" variable is not set. Defaulting to a blank string.`,
      `Error response from daemon: failed to create container: invalid volume specification`,
    ].join("\n");

    const result = parseMissingVariables(stderr);

    expect(result).toHaveLength(3);
    const names = result.map((v: MissingVariable) => v.variable);
    expect(names).toEqual(["UMBREL_ROOT", "DEVI", "APP_PASSWORD"]);

    // Each has errorType: "missing_env_variable"
    result.forEach((v: MissingVariable) => {
      expect(v.errorType).toBe("missing_env_variable");
      expect(v.displayMessage).toMatch(/^Missing environment variable: /);
      expect(v.suggestion).toBeTruthy();
    });

    // DEVI flagged as typo
    const devi = result.find((v: MissingVariable) => v.variable === "DEVI")!;
    expect(devi.suggestion).toContain("typo");
  });

  it("extracts file:line reference from compose file path in stderr", () => {
    const stderr = `Error in /opt/apps/compose.yml:42: variable "DB_URL" is not set and no default value`;
    const result = parseMissingVariables(stderr);

    expect(result).toHaveLength(1);
    expect(result[0].variable).toBe("DB_URL");
    expect(result[0].composePath).toBe("/opt/apps/compose.yml");
    expect(result[0].line).toBe("42");
    expect(result[0].expectedIn).toContain("/opt/apps/compose.yml:42");
  });

  it("variable_missing list can be serialized to JSON for API response", () => {
    const stderr = `The "REDIS_URL" variable is not set`;
    const result = parseMissingVariables(stderr);

    // Simulate what getLastErrorWithVariables returns
    const apiResponse = {
      variablesMissing: result,
      variable_missing: result,
      variableNames: result.map((v: MissingVariable) => v.variable),
      displayMessages: result.map((v: MissingVariable) => v.displayMessage),
    };

    const serialized = JSON.parse(JSON.stringify(apiResponse));
    expect(serialized.variablesMissing).toHaveLength(1);
    expect(serialized.variable_missing).toHaveLength(1);
    expect(serialized.variableNames).toEqual(["REDIS_URL"]);
    expect(serialized.displayMessages[0]).toContain("Missing environment variable: REDIS_URL");
  });

  it("handles empty stderr gracefully", () => {
    const result = parseMissingVariables("");
    expect(result).toEqual([]);
  });

  it("handles stderr with only non-variable errors", () => {
    const stderr = [
      `Error response from daemon: Conflict. The container name "/myapp" is already in use`,
      `pull access denied for myimage, repository does not exist`,
    ].join("\n");

    const result = parseMissingVariables(stderr);
    expect(result).toEqual([]);
  });
});
