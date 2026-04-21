import { homedir } from "node:os";
import { join } from "node:path";
import { db, schema } from "../db/index.js";
import { eq, desc, and } from "drizzle-orm";

export interface MissingVariable {
  errorType: "missing_env_variable";
  variable: string;
  suggestion: string;
  displayMessage: string;
  expectedIn?: string;
  line?: string;
  composePath?: string;
}

export interface ContainerStartupEvent {
  id: number;
  containerId: string;
  containerName: string;
  newState: string;
  reason: string | null;
  context: Record<string, unknown>;
  createdAt: string;
}

export interface StartupFailure {
  id: number;
  appId: string;
  service: string;
  command: string;
  exitCode: number | null;
  stderr: string;
  stdout: string;
  parsedIssue: {
    variables: string[];
    variablesMissing?: MissingVariable[];
    errorCode: string;
    services: string[];
    line?: string;
    composePath?: string;
    context: string;
  } | null;
  suggestion: string | null;
  variablesInvolved: string[];
  variablesMissing: MissingVariable[];
  variable_missing: MissingVariable[];
  variableNames: string[];
  displayMessages: string[];
  composePath: string | null;
  envVarsAtTime: Record<string, string>;
  createdAt: string;
  containerEvents: ContainerStartupEvent[];
}

/**
 * Parse stderr from a docker compose command and extract structured per-variable
 * error objects for any missing environment variables.
 *
 * Handles four Docker Compose output patterns:
 *  - Error: The "VAR" variable is not set
 *  - Error: variable "VAR" is not set and no default value
 *  - WARN[0000] The "VAR" variable is not set. Defaulting to a blank string.
 *  - invalid interpolation format for VAR
 */
export function parseMissingVariables(
  stderr: string,
  opts?: { line?: string; composePath?: string },
): MissingVariable[] {
  const talomeDir = join(homedir(), ".talome");
  const variables: string[] = [];

  // "The "VAR" variable is not set"
  const pat1 = /The "([^"]+)" variable is not set/g;
  let m: RegExpExecArray | null;
  while ((m = pat1.exec(stderr)) !== null) {
    if (!variables.includes(m[1])) variables.push(m[1]);
  }

  // 'variable "VAR" is not set and no default value'
  const pat2 = /variable "([^"]+)" is not set/g;
  while ((m = pat2.exec(stderr)) !== null) {
    if (!variables.includes(m[1])) variables.push(m[1]);
  }

  // Docker Compose v2 warning format: WARN[0000] The "VAR" variable is not set. Defaulting to a blank string.
  const patWarn = /WARN\[\d+\]\s*The "([^"]+)" variable is not set/g;
  while ((m = patWarn.exec(stderr)) !== null) {
    if (!variables.includes(m[1])) variables.push(m[1]);
  }

  // invalid interpolation format for VAR (bare $ without braces)
  const pat3 = /invalid interpolation format for ([^\s:]+)/g;
  while ((m = pat3.exec(stderr)) !== null) {
    if (!variables.includes(m[1])) variables.push(m[1]);
  }

  // Extract line reference
  let line = opts?.line;
  if (!line) {
    const lineMatch = stderr.match(/line (\d+)/i);
    if (lineMatch) line = lineMatch[1];
    if (!line) {
      const fileLineMatch = stderr.match(/(?:compose|yml|yaml)[^:]*:(\d+)/i);
      if (fileLineMatch) line = fileLineMatch[1];
    }
  }

  // Extract compose file path
  let composePath = opts?.composePath;
  if (!composePath) {
    const pathMatch = stderr.match(/(\/[^\s"']+(?:docker-compose|compose)[^\s"']*\.ya?ml)/i);
    if (pathMatch) composePath = pathMatch[1];
  }

  return variables.map((variable) => {
    let suggestion: string;
    if (variable === "UMBREL_ROOT") {
      suggestion = `Set UMBREL_ROOT=${talomeDir} in your .env file or docker-compose context`;
    } else if (variable === "DEVI" || variable.startsWith("DEV")) {
      suggestion = `Check for typos — ${variable} may be a misspelling. Review the compose file${line ? ` around line ${line}` : ""} and correct the variable name, or set it in your configuration`;
    } else {
      suggestion = `Set ${variable} in the app's environment configuration or .env file${line ? ` (referenced around line ${line})` : ""}`;
    }

    let expectedIn: string | undefined;
    if (variable === "UMBREL_ROOT") {
      expectedIn = composePath
        ? `${composePath}${line ? `:${line}` : ""} — required by Umbrel-format apps`
        : ".env file or docker-compose environment block";
    } else if (composePath) {
      expectedIn = `${composePath}${line ? `:${line}` : ""}`;
    } else if (line) {
      expectedIn = `compose file line ${line}`;
    }

    const displayMessage = `Missing environment variable: ${variable} — ${suggestion}`;

    return {
      errorType: "missing_env_variable" as const,
      variable,
      suggestion,
      displayMessage,
      ...(expectedIn ? { expectedIn } : {}),
      ...(line ? { line } : {}),
      ...(composePath ? { composePath } : {}),
    };
  });
}

/**
 * Return the last N startup failures for a given app, newest first.
 * Queries install_errors + correlated container_events for full context.
 */
export function getStartupFailures(appId: string, limit = 5): StartupFailure[] {
  const rows = db
    .select()
    .from(schema.installErrors)
    .where(eq(schema.installErrors.appId, appId))
    .orderBy(desc(schema.installErrors.id))
    .limit(limit)
    .all();

  // Fetch container startup_failure events for this app
  const events = db
    .select()
    .from(schema.containerEvents)
    .where(
      and(
        eq(schema.containerEvents.containerId, appId),
        eq(schema.containerEvents.newState, "startup_failure"),
      ),
    )
    .orderBy(desc(schema.containerEvents.createdAt))
    .limit(limit)
    .all();

  const parsedEvents: ContainerStartupEvent[] = events.map((e) => ({
    id: e.id,
    containerId: e.containerId,
    containerName: e.containerName,
    newState: e.newState,
    reason: e.reason,
    context: e.context ? JSON.parse(e.context) : {},
    createdAt: e.createdAt,
  }));

  return rows.map((row) => {
    // Match container events by timestamp proximity (within 2 seconds)
    const rowTime = new Date(row.createdAt).getTime();
    const related = parsedEvents.filter((e) => {
      const eventTime = new Date(e.createdAt).getTime();
      return Math.abs(eventTime - rowTime) < 2000;
    });

    const parsed = row.parsedIssue ? JSON.parse(row.parsedIssue) : null;

    // Derive structured variablesMissing — prefer stored value, fall back to parsing stderr
    let variablesMissing: MissingVariable[];
    if (row.variablesMissing) {
      variablesMissing = JSON.parse(row.variablesMissing);
    } else {
      variablesMissing = parseMissingVariables(row.stderr, {
        line: parsed?.line,
        composePath: parsed?.composePath ?? row.composePath ?? undefined,
      });
    }

    return {
      id: row.id,
      appId: row.appId,
      service: row.service,
      command: row.command,
      exitCode: row.exitCode,
      stderr: row.stderr,
      stdout: row.stdout,
      parsedIssue: parsed,
      suggestion: row.suggestion ?? null,
      variablesInvolved: JSON.parse(row.variablesInvolved),
      variablesMissing,
      variable_missing: variablesMissing,
      variableNames: variablesMissing.map((v) => v.variable),
      displayMessages: variablesMissing.map((v) => v.displayMessage),
      composePath: row.composePath ?? null,
      envVarsAtTime: row.envVarsAtTime ? JSON.parse(row.envVarsAtTime) : {},
      createdAt: row.createdAt,
      containerEvents: related,
    };
  });
}

/**
 * Get the last install error for an app with fully parsed variable info.
 * Returns null if no error found. Encapsulates the DB query, JSON parsing,
 * and variable extraction for use by API routes.
 */
export function getLastErrorWithVariables(appId: string) {
  const error = db
    .select()
    .from(schema.installErrors)
    .where(eq(schema.installErrors.appId, appId))
    .orderBy(desc(schema.installErrors.createdAt))
    .limit(1)
    .get();

  if (!error) return null;

  const parsed = error.parsedIssue ? JSON.parse(error.parsedIssue) : null;

  // Derive structured variablesMissing — prefer stored value, fall back to parsing stderr
  let variablesMissing: MissingVariable[];
  if (error.variablesMissing) {
    variablesMissing = JSON.parse(error.variablesMissing);
  } else {
    variablesMissing = parseMissingVariables(error.stderr, {
      line: parsed?.line,
      composePath: parsed?.composePath ?? error.composePath ?? undefined,
    });
  }

  const variableNames = variablesMissing.map((v) => v.variable);
  const displayMessages = variablesMissing.map((v) => v.displayMessage);

  return {
    id: error.id,
    appId: error.appId,
    service: error.service,
    command: error.command,
    exitCode: error.exitCode,
    stderr: error.stderr,
    stdout: error.stdout,
    parsedIssue: parsed,
    suggestion: error.suggestion ?? null,
    variablesInvolved: JSON.parse(error.variablesInvolved),
    variablesMissing,
    variable_missing: variablesMissing,
    variableNames,
    displayMessages,
    composePath: error.composePath ?? null,
    envVarsAtTime: error.envVarsAtTime ? JSON.parse(error.envVarsAtTime) : {},
    createdAt: error.createdAt,
  };
}
