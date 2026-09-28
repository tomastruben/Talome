/**
 * Umbrel catalog compatibility report — CLI.
 *
 * Parses every app in a local umbrel-apps checkout, applies Talome's Umbrel
 * 2.0 install mapping with default choices and validates the resulting
 * compose files. Read-only (no writes, Docker, network or database).
 *
 * Usage:
 *   pnpm exec tsx scripts/umbrel-compat-report.ts <path-to-umbrel-apps> [--json] [--top N]
 */
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  buildUmbrelCompatReport,
  formatUmbrelCompatReport,
} from "../src/stores/adapters/umbrel-compat-report.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const storeArg = args.find((a) => !a.startsWith("--"));
  if (!storeArg) {
    console.error("Usage: tsx scripts/umbrel-compat-report.ts <path-to-umbrel-apps> [--json] [--top N]");
    process.exitCode = 2;
    return;
  }
  const topIndex = args.indexOf("--top");
  const topN = topIndex >= 0 ? Math.max(1, parseInt(args[topIndex + 1] ?? "10", 10) || 10) : 10;
  const report = await buildUmbrelCompatReport(resolve(storeArg), topN);
  if (args.includes("--json")) console.log(JSON.stringify(report, null, 2));
  else console.log(formatUmbrelCompatReport(report, topN));
}

// Run only when executed directly (importing the module stays side-effect free).
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void main();
}
