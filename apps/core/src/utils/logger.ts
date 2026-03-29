/**
 * Structured logger for Talome core.
 *
 * - Dev: human-readable single-line format
 * - Prod: JSON-structured for machine parsing
 *
 * Usage:
 *   import { createLogger } from "../utils/logger.js";
 *   const log = createLogger("my-component");
 *   log.info("Server started", { port: 4000 });
 */

type LogLevel = "debug" | "info" | "warn" | "error";

interface Logger {
  debug: (msg: string, data?: unknown) => void;
  info: (msg: string, data?: unknown) => void;
  warn: (msg: string, data?: unknown) => void;
  error: (msg: string, data?: unknown) => void;
}

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const isDev = process.env.NODE_ENV !== "production";

// Minimum log level — debug only shown in dev unless LOG_LEVEL overrides
const minLevel: LogLevel = (process.env.LOG_LEVEL as LogLevel) ?? (isDev ? "debug" : "info");
const minPriority = LEVEL_PRIORITY[minLevel] ?? 1;

function formatDev(level: LogLevel, tag: string, msg: string, data?: unknown): string {
  const ts = new Date().toISOString();
  const lvl = level.toUpperCase().padEnd(5);
  const base = `[${ts}] [${lvl}] [${tag}] ${msg}`;
  if (data === undefined) return base;
  if (data instanceof Error) return `${base} ${data.stack ?? data.message}`;
  if (typeof data === "string") return `${base} ${data}`;
  try {
    return `${base} ${JSON.stringify(data)}`;
  } catch {
    return `${base} [unserializable]`;
  }
}

function formatProd(level: LogLevel, tag: string, msg: string, data?: unknown): string {
  const entry: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    tag,
    msg,
  };
  if (data !== undefined) {
    if (data instanceof Error) {
      entry.error = { message: data.message, stack: data.stack };
    } else {
      entry.data = data;
    }
  }
  try {
    return JSON.stringify(entry);
  } catch {
    return JSON.stringify({ ...entry, data: "[unserializable]" });
  }
}

function write(level: LogLevel, tag: string, msg: string, data?: unknown): void {
  if (LEVEL_PRIORITY[level] < minPriority) return;

  const line = isDev
    ? formatDev(level, tag, msg, data)
    : formatProd(level, tag, msg, data);

  switch (level) {
    case "error":
      console.error(line);
      break;
    case "warn":
      console.warn(line);
      break;
    default:
      console.log(line);
  }
}

export function createLogger(tag: string): Logger {
  return {
    debug: (msg, data) => write("debug", tag, msg, data),
    info: (msg, data) => write("info", tag, msg, data),
    warn: (msg, data) => write("warn", tag, msg, data),
    error: (msg, data) => write("error", tag, msg, data),
  };
}

/** Default logger instance for general use. */
export const log = createLogger("core");
