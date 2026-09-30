/**
 * Worker entry: runs PRAGMA integrity_check off the main thread so a large
 * database doesn't block the event loop during verification.
 */
import { parentPort, workerData } from "node:worker_threads";
import { integrityCheckSync } from "./sqlite-integrity.js";

const { path } = workerData as { path: string };
parentPort?.postMessage(integrityCheckSync(path));
