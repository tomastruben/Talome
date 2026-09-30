import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { TalomeAppSpec } from "@talome/types";
import type { ValidationCheck } from "./contracts.js";
import { listGeneratedFiles } from "./workspace-files.js";
import { runNativeBrowserHarness } from "./browser-process.js";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const dashboardRoot = join(projectRoot, "apps", "dashboard");
const harnessPath = join(projectRoot, "scripts", "validate-native-app.mjs");

const BindingSchema = z.object({
  appId: z.string(), sourceSha256: z.string().length(64), specSha256: z.string().length(64),
  rendererBuildId: z.string().min(1), rendererSha256: z.string().length(64), harnessSha256: z.string().length(64), fileCount: z.number().int().nonnegative(),
});
export const NativeBrowserReportSchema = z.object({
  version: z.literal(1), scope: z.literal("native-renderer-fixture"), binding: BindingSchema,
  generatedAt: z.string(), status: z.enum(["passed", "failed"]),
  checks: z.array(z.object({ id: z.string(), status: z.enum(["passed", "failed", "skipped"]), details: z.string() })),
  screenshots: z.array(z.string()), unverified: z.array(z.string()).min(1),
  screenshotHashes: z.record(z.string(), z.string()).optional(),
});
export type NativeBrowserReport = z.infer<typeof NativeBrowserReportSchema>;

async function fingerprintRenderer() {
  const standaloneRoot = join(dashboardRoot, ".next/standalone/apps/dashboard");
  const nextRoot = join(standaloneRoot, ".next");
  const hash = createHash("sha256");
  hash.update(await readFile(join(standaloneRoot, "server.js")));
  for (const path of await listGeneratedFiles(nextRoot)) {
    const content = await readFile(join(nextRoot, path));
    hash.update(JSON.stringify([path, content.length]));
    hash.update(content);
  }
  return { rendererBuildId: (await readFile(join(nextRoot, "BUILD_ID"), "utf8")).trim(), rendererSha256: hash.digest("hex") };
}

/** Hash actual file bytes and paths, not a model-authored list or validation claim. */
export async function fingerprintNativeWorkspace(scaffoldPath: string, spec: TalomeAppSpec) {
  const files = await listGeneratedFiles(scaffoldPath);
  const hash = createHash("sha256");
  for (const path of files) {
    const content = await readFile(join(scaffoldPath, path));
    hash.update(JSON.stringify([path, content.length]));
    hash.update(content);
  }
  return {
    appId: spec.appId,
    sourceSha256: hash.digest("hex"),
    specSha256: createHash("sha256").update(JSON.stringify(spec)).digest("hex"),
    fileCount: files.length,
  };
}

export function assertNativeBrowserEvidence(report: NativeBrowserReport, binding: z.infer<typeof BindingSchema>, surfaceIds: string[], hasDynamicData = false, chartIds: string[] = []) {
  if (JSON.stringify(report.binding) !== JSON.stringify(BindingSchema.parse(binding))) throw new Error("Browser evidence does not match the generated files, native contract, or renderer build.");
  const widths = [390, 480, 768, 1440];
  const required = [...surfaceIds.flatMap((id) => widths.map((width) => `surface:${width}:${id}`)), ...chartIds.flatMap((id) => widths.map((width) => `chart:${width}:${id}`)), "isolation", "console", ...(hasDynamicData ? ["data:error-recovery", "data:empty"] : [])];
  if (report.status !== "passed" || report.checks.some((check) => check.status === "failed")) {
    throw new Error(report.checks.filter((check) => check.status === "failed").map((check) => check.details).join("; ") || "Native browser validation failed");
  }
  for (const id of required) {
    if (!report.checks.some((check) => check.id === id && check.status === "passed")) throw new Error(`Browser evidence is missing ${id}.`);
  }
  if (!report.checks.some((check) => ["action:fixture-result", "action:input-handoff", "action:assistant-handoff"].includes(check.id)) || !["data:error-recovery", "data:empty"].every((id) => report.checks.some((check) => check.id === id))) {
    throw new Error("Browser evidence must state which action and error-recovery checks ran or were inapplicable.");
  }
  if (report.screenshots.length < surfaceIds.length * widths.length) throw new Error("Browser evidence is missing surface screenshots.");
}

interface NativeBrowserDependencies {
  renderer?: typeof fingerprintRenderer;
  execute?: (input: unknown) => Promise<string>;
}

/** Start the shipped renderer in isolation and produce fresh evidence on every completion. */
export async function validateNativeAppInBrowser(scaffoldPath: string, spec: TalomeAppSpec, dependencies: NativeBrowserDependencies = {}): Promise<ValidationCheck[]> {
  const outputDir = join(dirname(scaffoldPath), ".talome-creator", "validation", "native-browser", randomUUID());
  const reportPath = join(outputDir, "report.json");
  const check: ValidationCheck = {
    id: "native-browser", label: "Native renderer works with isolated fixtures", status: "failed",
    scope: "native-renderer-fixture", evidencePath: reportPath,
  };
  try {
    const binding = BindingSchema.parse({
      ...await fingerprintNativeWorkspace(scaffoldPath, spec),
      ...await (dependencies.renderer ?? fingerprintRenderer)(),
      harnessSha256: createHash("sha256").update(await readFile(harnessPath)).digest("hex"),
    });
    await mkdir(outputDir, { recursive: true });
    const input = { spec, dashboardRoot, outputDir, binding };
    await writeFile(join(outputDir, "input.json"), JSON.stringify(input), { mode: 0o600 });
    const stdout = dependencies.execute
      ? await dependencies.execute(input)
      : await runNativeBrowserHarness(harnessPath, input, projectRoot);
    const report = NativeBrowserReportSchema.parse(JSON.parse(stdout));
    assertNativeBrowserEvidence(report, binding, spec.surfaces.map((surface) => surface.id), spec.dataSources.some((source) => source.kind !== "static"), spec.surfaces.flatMap((surface) => surface.blocks.filter((block) => block.component === "time-series").map((block) => `${surface.id}:${block.id}`)));
    const after = await fingerprintNativeWorkspace(scaffoldPath, spec);
    if (after.sourceSha256 !== binding.sourceSha256) throw new Error("Generated files changed during browser validation; rerun completion.");
    if ((await (dependencies.renderer ?? fingerprintRenderer)()).rendererSha256 !== binding.rendererSha256 || createHash("sha256").update(await readFile(harnessPath)).digest("hex") !== binding.harnessSha256) {
      throw new Error("Renderer or browser harness changed during validation; rerun completion.");
    }
    report.screenshotHashes = {};
    for (const screenshot of report.screenshots) {
      if (basename(screenshot) !== screenshot) throw new Error("Invalid browser screenshot path.");
      const content = await readFile(join(outputDir, screenshot));
      if (!content.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error(`Invalid screenshot evidence: ${screenshot}`);
      report.screenshotHashes[screenshot] = createHash("sha256").update(content).digest("hex");
    }
    await writeFile(reportPath, JSON.stringify(report, null, 2));
    check.status = "passed";
    check.details = `${spec.surfaces.length} native surface(s) at 390, 480, 768 and 1440 px; dark mode, block rendering, chart marks and accessible data, navigation and applicable fixture action/error recovery checks. App service behavior is unverified.`;
  } catch (error) {
    check.details = error instanceof Error ? error.message.slice(0, 1600) : "Native browser validation failed";
  }
  return [check, {
    id: "app-runtime", label: "Generated app service workflow", status: "skipped", scope: "app-runtime",
    details: "Not exercised by the isolated native renderer check. Real service data, external UI and real action effects require separate runtime verification.",
  }];
}
