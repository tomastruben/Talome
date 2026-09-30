/**
 * Umbrel catalog compatibility report (library for scripts/umbrel-compat-report.ts).
 *
 * Parses every app in a local umbrel-apps checkout with Talome's Umbrel
 * adapter, plans + applies the Umbrel 2.0 install mapping with default
 * choices, validates the resulting compose document and summarises counts and
 * the most common failure reasons. Read-only: no writes, no Docker, no
 * network, no database.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import yaml from "js-yaml";
import { scanUmbrelStore } from "./umbrel-adapter.js";
import {
  applyUmbrelV2Plan,
  isTalomeProvidedUmbrelVar,
  planUmbrelV2Install,
  stripUmbrelProxy,
  validateTransformedCompose,
  type UmbrelV2Context,
} from "../umbrel-v2.js";

export interface UmbrelCompatReport {
  storePath: string;
  appDirs: number;
  parsed: number;
  parseFailures: number;
  withoutCompose: number;
  installable: number;
  unsupported: number;
  blocked: number;
  invalidCompose: number;
  manifestWarnings: number;
  features: Record<string, number>;
  topParseFailures: [string, number][];
  topBlockers: [string, number][];
  topComposeIssues: [string, number][];
  topManifestWarnings: [string, number][];
  failingApps: { id: string; reason: string }[];
}

function bump(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function top(map: Map<string, number>, n: number): [string, number][] {
  return [...map.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, n);
}

/** Collapse app-specific details so identical causes group together. */
function reasonKey(reason: string): string {
  return reason
    .replace(/"[^"]*"/g, '"…"')
    .replace(/\[\d+\]/g, "[n]")
    .replace(/ — .*$/, "");
}

function contextFor(appId: string): UmbrelV2Context {
  return {
    appId,
    paths: {
      appDataDir: `/srv/talome/app-data/${appId}`,
      appDataParent: "/srv/talome/app-data",
      mediaRoot: "/srv/media",
      downloadsRoot: "/srv/downloads",
      booksRoot: "/srv/media/books",
    },
    installedApps: [],
    hasDri: true,
  };
}

export async function buildUmbrelCompatReport(storePath: string, topN = 10): Promise<UmbrelCompatReport> {
  const scanned = await scanUmbrelStore(storePath, "compat-report", {
    id: "compat-report",
    name: "compat-report",
    type: "umbrel",
    gitUrl: "https://github.com/getumbrel/umbrel-apps.git",
    branch: "master",
    enabled: true,
    appCount: 0,
  });

  const parseFailures = new Map<string, number>();
  const blockers = new Map<string, number>();
  const composeIssues = new Map<string, number>();
  const manifestWarnings = new Map<string, number>();
  const features = new Map<string, number>();
  const failingApps: { id: string; reason: string }[] = [];
  const report: UmbrelCompatReport = {
    storePath,
    appDirs: scanned.length,
    parsed: 0,
    parseFailures: 0,
    withoutCompose: 0,
    installable: 0,
    unsupported: 0,
    blocked: 0,
    invalidCompose: 0,
    manifestWarnings: 0,
    features: {},
    topParseFailures: [],
    topBlockers: [],
    topComposeIssues: [],
    topManifestWarnings: [],
    failingApps,
  };

  for (const { entry, appDir, result } of scanned) {
    if (!result.ok) {
      report.parseFailures++;
      bump(parseFailures, reasonKey(result.error));
      failingApps.push({ id: entry, reason: result.error });
      continue;
    }
    report.parsed++;
    const manifest = result.manifest;
    const meta = manifest.umbrelMeta ?? {};
    if (result.warnings.length > 0) report.manifestWarnings++;
    for (const w of result.warnings) bump(manifestWarnings, reasonKey(w));

    if (meta.manifestVersion) bump(features, `manifestVersion ${meta.manifestVersion}`);
    if (meta.folderAccess?.length) bump(features, "folderAccess");
    if (meta.environment?.length) bump(features, "environment");
    if (meta.storage) bump(features, "storage.dataRoot");
    if (meta.implements?.length) bump(features, "implements");
    if (meta.dependencies?.length) bump(features, "dependencies");
    if (meta.permissions?.some((p) => p.toUpperCase() === "GPU")) bump(features, "GPU");
    if (meta.torOnly) bump(features, "torOnly");
    if (meta.requiresHttps) bump(features, "requiresHttps");
    if (meta.backupIgnore?.length) bump(features, "backupIgnore");
    if (meta.disabled) bump(features, "disabled");
    if (meta.unknownFields) bump(features, "unknown fields");

    let compose: Record<string, unknown> | null = null;
    try {
      const loaded = yaml.load(await readFile(join(appDir, "docker-compose.yml"), "utf-8"));
      if (loaded && typeof loaded === "object" && !Array.isArray(loaded)) compose = loaded as Record<string, unknown>;
    } catch {
      compose = null;
    }
    if (!compose) {
      report.withoutCompose++;
      failingApps.push({ id: manifest.id, reason: "missing or invalid docker-compose.yml" });
      continue;
    }

    const base = stripUmbrelProxy(compose);
    const plan = planUmbrelV2Install(meta, base, {}, contextFor(manifest.id));
    if (!plan.supported) {
      report.unsupported++;
      bump(blockers, reasonKey(plan.unsupportedReason ?? "unsupported"));
      failingApps.push({ id: manifest.id, reason: plan.unsupportedReason ?? "unsupported" });
      continue;
    }
    if (plan.blockers.length > 0) {
      report.blocked++;
      for (const b of plan.blockers) bump(blockers, reasonKey(b));
      failingApps.push({ id: manifest.id, reason: plan.blockers.join(" ") });
      continue;
    }

    const { compose: transformed } = applyUmbrelV2Plan(base, plan);
    const issues = validateTransformedCompose(
      transformed,
      (name) => isTalomeProvidedUmbrelVar(name) || name in plan.interpolationEnv,
    );
    if (issues.length > 0) {
      report.invalidCompose++;
      for (const issue of issues) {
        if (issue.startsWith("unresolved variables: ")) {
          for (const v of issue.slice("unresolved variables: ".length).split(", ")) bump(composeIssues, `unresolved \${${v}}`);
        } else {
          bump(composeIssues, reasonKey(issue));
        }
      }
      failingApps.push({ id: manifest.id, reason: issues.join("; ") });
      continue;
    }
    report.installable++;
  }

  report.features = Object.fromEntries([...features.entries()].sort((a, b) => b[1] - a[1]));
  report.topParseFailures = top(parseFailures, topN);
  report.topBlockers = top(blockers, topN);
  report.topComposeIssues = top(composeIssues, topN);
  report.topManifestWarnings = top(manifestWarnings, topN);
  return report;
}

export function formatUmbrelCompatReport(report: UmbrelCompatReport, topN = 10): string {
  const pct = (n: number) => (report.parsed ? ` (${((n / report.parsed) * 100).toFixed(1)}%)` : "");
  const lines = [
    `Umbrel compatibility report — ${report.storePath}`,
    "",
    `App directories:            ${report.appDirs}`,
    `Parsed:                     ${report.parsed}`,
    `Parse failures:             ${report.parseFailures}`,
    `Installable (valid compose): ${report.installable}${pct(report.installable)}`,
    `Unsupported (torOnly):      ${report.unsupported}${pct(report.unsupported)}`,
    `Blocked by install checks:  ${report.blocked}`,
    `Invalid compose after map:  ${report.invalidCompose}${pct(report.invalidCompose)}`,
    `Missing/invalid compose:    ${report.withoutCompose}`,
    `Manifests with warnings:    ${report.manifestWarnings}`,
    "",
    "Feature usage:",
    ...Object.entries(report.features).map(([k, v]) => `  ${String(v).padStart(5)}  ${k}`),
  ];
  const section = (title: string, rows: [string, number][]) => {
    if (rows.length === 0) return;
    lines.push("", `${title} (top ${topN}):`, ...rows.map(([k, v]) => `  ${String(v).padStart(5)}  ${k}`));
  };
  section("Parse failures", report.topParseFailures);
  section("Blockers", report.topBlockers);
  section("Compose issues", report.topComposeIssues);
  section("Manifest warnings", report.topManifestWarnings);
  return lines.join("\n");
}
