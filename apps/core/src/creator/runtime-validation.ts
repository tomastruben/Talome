import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { TalomeAppSpec } from "@talome/types";
import type { ValidationCheck } from "./contracts.js";
import { fingerprintNativeWorkspace } from "./browser-validation.js";
import { runNativeBrowserHarness } from "./browser-process.js";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const harnessPath = join(projectRoot, "scripts/validate-stopwatch-runtime.mjs");
const adapterFiles = ["server.py", "stopwatch.py"] as const;
const descriptorSchema = z.object({ version: z.literal(1), adapter: z.literal("stopwatch-v1") }).strict();
const bindingSchema = z.object({
  appId: z.string(), sourceSha256: z.string().length(64), specSha256: z.string().length(64),
  fileCount: z.number().int().nonnegative(), adapterSha256: z.string().length(64), harnessSha256: z.string().length(64),
});
const requiredChecks = ["fresh-state", "invalid-actions", "start-and-label", "elapsed-and-lap", "pause", "restart-persistence", "running-recovery", "confirmed-reset", "isolation"];
export const RuntimeReportSchema = z.object({
  version: z.literal(1), scope: z.literal("app-runtime"), adapter: z.literal("stopwatch-v1"),
  binding: bindingSchema, generatedAt: z.string(), status: z.enum(["passed", "failed"]),
  checks: z.array(z.object({ id: z.string(), status: z.enum(["passed", "failed"]), details: z.string() })),
  unverified: z.array(z.string()).min(1),
});

export function assertRuntimeEvidence(report: z.infer<typeof RuntimeReportSchema>, binding: z.infer<typeof bindingSchema>) {
  if (JSON.stringify(report.binding) !== JSON.stringify(bindingSchema.parse(binding))) throw new Error("Runtime evidence does not match the source, native contract, reviewed adapter, or runner.");
  if (report.status !== "passed" || report.checks.some((check) => check.status === "failed")) throw new Error(report.checks.filter((check) => check.status === "failed").map((check) => check.details).join("; ") || "Runtime workflow failed.");
  for (const id of requiredChecks) if (!report.checks.some((check) => check.id === id && check.status === "passed")) throw new Error(`Runtime evidence is missing ${id}.`);
}

/** Only reviewed, byte-identical adapters run. This is orchestration isolation, not an OS sandbox. */
export async function validateAppRuntime(scaffoldPath: string, spec: TalomeAppSpec, dependencies: {
  execute?: (input: unknown) => Promise<string>;
} = {}): Promise<ValidationCheck> {
  const check: ValidationCheck = { id: "app-runtime", label: "Generated app service workflow", scope: "app-runtime", status: "failed" };
  try {
    let descriptor: string;
    try { descriptor = await readFile(join(scaffoldPath, "talome-runtime-probe.json"), "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return { ...check, status: "skipped", details: "No supported runtime probe declared. Real backend behavior, external UI, and production integration remain unverified." };
    }
    descriptorSchema.parse(JSON.parse(descriptor));
    const sources: Record<string, string> = {};
    for (const file of adapterFiles) {
      const actual = await readFile(join(scaffoldPath, file));
      const reviewed = await readFile(join(projectRoot, "apps/stopwatch", file));
      if (!actual.equals(reviewed)) throw new Error(`Runtime adapter requires the reviewed ${file} bytes; modified backends need a separately reviewed adapter.`);
      sources[file] = actual.toString("base64");
    }
    const adapterSha256 = createHash("sha256").update(JSON.stringify(sources)).digest("hex");
    const binding = bindingSchema.parse({ ...await fingerprintNativeWorkspace(scaffoldPath, spec), adapterSha256,
      harnessSha256: createHash("sha256").update(await readFile(harnessPath)).digest("hex") });
    const input = { binding, sources };
    const stdout = dependencies.execute ? await dependencies.execute(input)
      : await runNativeBrowserHarness(harnessPath, input, projectRoot, { timeoutMs: 30_000, maxOutputBytes: 256 * 1024 });
    const report = RuntimeReportSchema.parse(JSON.parse(stdout));
    assertRuntimeEvidence(report, binding);
    if ((await fingerprintNativeWorkspace(scaffoldPath, spec)).sourceSha256 !== binding.sourceSha256) throw new Error("Generated files changed during runtime validation; rerun completion.");
    const reviewedAfter: Record<string, string> = {};
    for (const file of adapterFiles) reviewedAfter[file] = (await readFile(join(projectRoot, "apps/stopwatch", file))).toString("base64");
    if (createHash("sha256").update(JSON.stringify(reviewedAfter)).digest("hex") !== adapterSha256 || createHash("sha256").update(await readFile(harnessPath)).digest("hex") !== binding.harnessSha256) throw new Error("Reviewed adapter or runtime runner changed during validation; rerun completion.");
    const outputDir = join(dirname(scaffoldPath), ".talome-creator/validation/app-runtime", randomUUID());
    await mkdir(outputDir, { recursive: true, mode: 0o700 });
    check.evidencePath = join(outputDir, "report.json");
    await writeFile(check.evidencePath, JSON.stringify(report, null, 2), { mode: 0o600 });
    check.status = "passed";
    check.details = "Reviewed Stopwatch HTTP service: start, rename, elapsed time, lap, pause, restart persistence, running recovery and confirmed reset passed using disposable loopback state. Production integration and external UI remain unverified.";
  } catch (error) { check.details = error instanceof Error ? error.message.slice(0, 1600) : "Runtime validation failed."; }
  return check;
}
