import { Worker } from "node:worker_threads";
import type { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { integrityCheckSync, type SqliteIntegrityResult } from "./sqlite-integrity.js";

const INLINE_MAX_BYTES = 32 * 1024 * 1024;

function workerUrl(): URL | null {
  for (const name of ["./sqlite-integrity-worker.js", "./sqlite-integrity-worker.ts"]) {
    const url = new URL(name, import.meta.url);
    if (existsSync(fileURLToPath(url))) return url;
  }
  return null;
}

function runInWorker(url: URL, path: string): Promise<SqliteIntegrityResult | null> {
  return new Promise((resolveResult) => {
    let settled = false;
    const worker = new Worker(url, { workerData: { path } });
    const events = worker as unknown as EventEmitter;
    events.once("message", (msg: SqliteIntegrityResult) => {
      settled = true;
      resolveResult(msg);
      void worker.terminate();
    });
    events.once("error", () => {
      if (!settled) resolveResult(null);
    });
    events.once("exit", () => {
      if (!settled) resolveResult(null);
    });
  });
}

/**
 * Integrity-check a SQLite database. Small files run inline; larger ones run
 * in a worker thread (falling back to inline if the worker can't start).
 */
export async function checkSqliteIntegrity(path: string, sizeBytes: number): Promise<SqliteIntegrityResult> {
  if (sizeBytes > INLINE_MAX_BYTES) {
    const url = workerUrl();
    if (url) {
      const result = await runInWorker(url, path);
      if (result) return result;
    }
  }
  return integrityCheckSync(path);
}
