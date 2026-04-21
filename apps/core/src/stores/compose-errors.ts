import { randomUUID } from "node:crypto";
import { db, schema } from "../db/index.js";
import { parseMissingVariables, type MissingVariable } from "../services/docker.js";

// ── Typed error codes ─────────────────────────────────────────────────────

export const ComposeErrorCode = {
  MISSING_VARIABLE: "missing_variable",
  INVALID_INTERPOLATION: "invalid_interpolation",
  PORT_CONFLICT: "port_conflict",
  PULL_DENIED: "pull_denied",
  NAME_CONFLICT: "name_conflict",
  IMAGE_NOT_FOUND: "image_not_found",
  YAML_SYNTAX: "yaml_syntax",
  TIMEOUT: "timeout",
  UNKNOWN: "compose_error",
} as const;

export type ComposeErrorCodeValue = typeof ComposeErrorCode[keyof typeof ComposeErrorCode];

// ── Types ─────────────────────────────────────────────────────────────────

export interface ParsedComposeIssue {
  errorType: string;
  variables: string[];
  variablesMissing: MissingVariable[];
  errorCode: ComposeErrorCodeValue;
  services: string[];
  line?: string;
  composePath?: string;
  context: string;
}

// ── Compose error parsing ─────────────────────────────────────────────────

export function parseComposeError(
  stderr: string,
  composePath?: string,
  opts?: { killed?: boolean },
): { parsedIssue: ParsedComposeIssue; suggestion: string } {
  // ── Timeout detection ───────────────────────────────────────────────
  // When exec kills a process (err.killed === true), the stderr may be empty.
  if (opts?.killed) {
    return {
      parsedIssue: {
        errorType: ComposeErrorCode.TIMEOUT,
        variables: [],
        variablesMissing: [],
        errorCode: ComposeErrorCode.TIMEOUT,
        services: [],
        composePath,
        context: stderr || "Process killed due to timeout",
      },
      suggestion: "Installation timed out. The image may be large — try again or check network connectivity.",
    };
  }

  // ── Delegate variable extraction to parseMissingVariables ───────────
  // This is the single source of truth for variable parsing — no duplicate regex here.
  const variablesMissing = parseMissingVariables(stderr, { composePath });
  const variables = variablesMissing.map((v) => v.variable);

  const services: string[] = [];
  let errorCode: ComposeErrorCodeValue = ComposeErrorCode.UNKNOWN;
  let line: string | undefined;

  // Check for invalid interpolation (not covered by parseMissingVariables)
  const pat3 = /invalid interpolation format for ([^\s:]+)/g;
  let m: RegExpExecArray | null;
  while ((m = pat3.exec(stderr)) !== null) {
    if (!variables.includes(m[1])) variables.push(m[1]);
    errorCode = ComposeErrorCode.INVALID_INTERPOLATION;
  }

  // Extract service names
  const pat4 = /service "([^"]+)"/g;
  while ((m = pat4.exec(stderr)) !== null) {
    if (!services.includes(m[1])) services.push(m[1]);
  }

  // Extract line references
  const lineMatch = stderr.match(/line (\d+)/i);
  if (lineMatch) line = lineMatch[1];
  if (!line) {
    const fileLineMatch = stderr.match(/(?:compose|yml|yaml)[^:]*:(\d+)/i);
    if (fileLineMatch) line = fileLineMatch[1];
  }

  // Classify error code (non-variable errors)
  if (variables.length > 0 && errorCode === ComposeErrorCode.UNKNOWN) {
    errorCode = ComposeErrorCode.MISSING_VARIABLE;
  }
  if (stderr.includes("port is already allocated")) errorCode = ComposeErrorCode.PORT_CONFLICT;
  if (stderr.includes("pull access denied")) errorCode = ComposeErrorCode.PULL_DENIED;
  if (stderr.includes("already in use")) errorCode = ComposeErrorCode.NAME_CONFLICT;
  if (stderr.includes("no such image")) errorCode = ComposeErrorCode.IMAGE_NOT_FOUND;
  if (stderr.includes("yaml:") || stderr.includes("YAML")) errorCode = ComposeErrorCode.YAML_SYNTAX;

  // Extract compose file path from stderr if not provided
  let detectedComposePath = composePath;
  if (!detectedComposePath) {
    const pathMatch = stderr.match(/(\/[^\s"']+(?:docker-compose|compose)[^\s"']*\.ya?ml)/i);
    if (pathMatch) detectedComposePath = pathMatch[1];
  }

  // Update variablesMissing with line/composePath context
  if (line || detectedComposePath) {
    for (const v of variablesMissing) {
      if (line && !v.line) v.line = line;
      if (detectedComposePath && !v.composePath) v.composePath = detectedComposePath;
    }
  }

  // Build suggestion
  const suggestion = buildSuggestion(errorCode, variables, line);

  // Determine error type
  let errorType: string = ComposeErrorCode.UNKNOWN;
  if (variables.length > 0) errorType = "missing_env_variable";
  else if (errorCode === ComposeErrorCode.INVALID_INTERPOLATION) errorType = "invalid_env_variable";
  else if (errorCode !== ComposeErrorCode.UNKNOWN) errorType = errorCode;

  return {
    parsedIssue: {
      errorType,
      variables,
      variablesMissing,
      errorCode,
      services,
      line,
      composePath: detectedComposePath,
      context: stderr,
    },
    suggestion: suggestion || "Check the full error output below for details.",
  };
}

function buildSuggestion(errorCode: ComposeErrorCodeValue, variables: string[], line?: string): string {
  if (variables.length > 0) {
    const varList = variables.join(", ");
    if (variables.includes("UMBREL_ROOT")) {
      return `Set UMBREL_ROOT to your Umbrel installation directory (e.g. /opt/umbrel). This variable is required by Umbrel-format apps. Either set it in the app's environment settings or add UMBREL_ROOT=/path/to/umbrel to your .env file. If you are not running an Umbrel-based setup, this app may not be compatible.`;
    }
    if (variables.some((v) => v === "DEVI" || v.startsWith("DEV"))) {
      return `The variable${variables.length > 1 ? "s" : ""} ${varList} ${variables.length > 1 ? "are" : "is"} not defined. Check the compose file for typos — DEVI is likely a misspelling of DEVICE or DEVID. Review the compose file around ${line ? `line ${line}` : "the flagged section"} and correct the variable name, or set the required variables in the app's environment configuration.`;
    }
    return `Set the missing variable${variables.length > 1 ? "s" : ""} ${varList} in the app's environment configuration before retrying.${line ? ` The error occurs around line ${line} of the compose file.` : ""}`;
  }

  switch (errorCode) {
    case ComposeErrorCode.PORT_CONFLICT:
      return "A required port is already in use by another service. Stop the conflicting service or change the port mapping.";
    case ComposeErrorCode.PULL_DENIED:
      return "The container image could not be pulled. Check that the image name is correct and accessible.";
    case ComposeErrorCode.IMAGE_NOT_FOUND:
      return "The specified container image was not found. Verify the image name and tag in the compose file.";
    case ComposeErrorCode.YAML_SYNTAX:
      return "The compose file contains a YAML syntax error. Check the file for formatting issues.";
    case ComposeErrorCode.TIMEOUT:
      return "Installation timed out. The image may be large — try again or check network connectivity.";
    default:
      return "";
  }
}

// ── Error recording ───────────────────────────────────────────────────────

export function recordInstallError(
  appId: string,
  command: string,
  err: any,
  composePath?: string,
  env?: Record<string, string>,
): void {
  const stderr = err?.stderr || err?.message || String(err);
  const stdout = err?.stdout || "";
  const exitCode: number | undefined = typeof err?.code === "number" ? err.code : undefined;
  const killed: boolean = err?.killed === true;

  const { parsedIssue, suggestion } = parseComposeError(stderr, composePath, { killed });
  const service = parsedIssue.services[0] || appId;
  const effectiveComposePath = composePath ?? parsedIssue.composePath ?? null;
  const variablesMissing = parsedIssue.variablesMissing;

  // Snapshot relevant env vars at time of failure (exclude process.env noise)
  const envSnapshot: Record<string, string> = {};
  if (env) {
    for (const key of ["PUID", "PGID", "TZ", "APP_DATA_DIR", "APP_ID", ...parsedIssue.variables]) {
      if (key in env) envSnapshot[key] = env[key];
    }
  }

  // Store in install_errors table — full stderr/stdout, no truncation
  try {
    db.insert(schema.installErrors)
      .values({
        appId,
        service,
        command,
        exitCode: exitCode ?? null,
        stderr,
        stdout,
        parsedIssue: JSON.stringify(parsedIssue),
        suggestion,
        variablesInvolved: JSON.stringify(parsedIssue.variables),
        variablesMissing: variablesMissing.length > 0 ? JSON.stringify(variablesMissing) : null,
        composePath: effectiveComposePath,
        envVarsAtTime: JSON.stringify(envSnapshot),
      })
      .run();
  } catch {
    // best-effort
  }

  // System event for agent loop detection
  try {
    db.insert(schema.systemEvents)
      .values({
        id: randomUUID(),
        type: "install_error",
        severity: "critical",
        source: appId,
        message: suggestion || parsedIssue.context,
        data: JSON.stringify({
          service,
          command,
          stderr,
          stdout,
          parsed_issue: parsedIssue,
          suggestion,
          errorType: parsedIssue.errorType,
          errorCode: parsedIssue.errorCode,
          variables: parsedIssue.variables,
          variables_missing: variablesMissing,
          line: parsedIssue.line ?? null,
          exitCode: exitCode ?? null,
          composePath: effectiveComposePath,
        }),
      })
      .run();
  } catch {
    // best-effort
  }

  // Container startup_failure event
  try {
    db.insert(schema.containerEvents)
      .values({
        containerId: appId,
        containerName: service,
        newState: "startup_failure",
        reason: parsedIssue.errorCode,
        context: JSON.stringify({
          error_type: parsedIssue.errorType,
          variable_missing: variablesMissing,
          full_stderr: stderr,
          full_stdout: stdout,
          compose_file_path: effectiveComposePath,
          line: parsedIssue.line ?? null,
          suggestion,
          command,
          exit_code: exitCode ?? null,
          services: parsedIssue.services,
        }),
      })
      .run();
  } catch {
    // best-effort
  }

  // Structured console log for external log aggregation
  console.error(
    JSON.stringify({
      level: "error",
      timestamp: new Date().toISOString(),
      event: "container_startup_failure",
      app_id: appId,
      service,
      error_type: parsedIssue.errorType,
      error_code: parsedIssue.errorCode,
      variable_missing: variablesMissing,
      variables_involved: parsedIssue.variables,
      line: parsedIssue.line ?? null,
      compose_path: effectiveComposePath,
      suggestion,
      command,
      exit_code: exitCode ?? null,
      stderr_length: stderr.length,
      stderr_preview: stderr.slice(0, 500),
    }),
  );
}
