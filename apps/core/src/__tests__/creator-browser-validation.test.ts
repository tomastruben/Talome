import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createDefaultAppSpec } from "../app-specs/schema.js";
import { assertNativeBrowserEvidence, fingerprintNativeWorkspace, NativeBrowserReportSchema, validateNativeAppInBrowser } from "../creator/browser-validation.js";
import { snapshotGeneratedWorkspace } from "../creator/workspace-snapshot.js";

const spec = createDefaultAppSpec({ appId: "fixture", name: "Fixture", description: "An isolated test." });
const binding = { appId: "fixture", sourceSha256: "a".repeat(64), specSha256: "b".repeat(64), rendererBuildId: "build-one", rendererSha256: "e".repeat(64), harnessSha256: "c".repeat(64), fileCount: 2 };
const report = () => NativeBrowserReportSchema.parse({ version: 1, scope: "native-renderer-fixture", binding, generatedAt: new Date().toISOString(), status: "passed", checks: ["surface:390:overview", "surface:480:overview", "surface:768:overview", "surface:1440:overview", "isolation", "console", "action:fixture-result", "data:error-recovery", "data:empty"].map((id) => ({ id, status: "passed", details: "Executed independently." })), screenshots: ["390.png", "480.png", "768.png", "1440.png"], unverified: ["Real application service"] });

describe("independent native browser evidence", () => {
  it.each(["Chrome executable is missing", "Browser process crashed", "Browser validation timed out"])("fails closed when %s", async (message) => {
    const root = await mkdtemp(join(tmpdir(), "talome-browser-failure-"));
    const scaffold = join(root, "generated-app");
    try {
      await mkdir(scaffold);
      await writeFile(join(scaffold, "talome-app.json"), JSON.stringify(spec));
      const checks = await validateNativeAppInBrowser(scaffold, spec, {
        renderer: async () => ({ rendererBuildId: "test", rendererSha256: "a".repeat(64) }),
        execute: async () => { throw new Error(message); },
      });
      expect(checks.find((check) => check.id === "native-browser")).toMatchObject({ status: "failed", details: message });
      expect(checks.find((check) => check.id === "app-runtime")?.status).toBe("skipped");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("validates a private immutable copy and rejects source symlinks", async () => {
    const root = await mkdtemp(join(tmpdir(), "talome-browser-snapshot-"));
    const source = join(root, "source");
    try {
      await mkdir(source);
      await writeFile(join(source, "server.py"), "original bytes");
      await writeFile(join(source, "creator.json"), "untrusted claims");
      const snapshot = await snapshotGeneratedWorkspace(source, join(root, "snapshots"));
      const fingerprint = await fingerprintNativeWorkspace(snapshot, spec);
      await writeFile(join(source, "server.py"), "edited after validation");
      expect(await readFile(join(snapshot, "server.py"), "utf8")).toBe("original bytes");
      expect(await fingerprintNativeWorkspace(snapshot, spec)).toEqual(fingerprint);
      expect(fingerprint.fileCount).toBe(1);
      await symlink(join(source, "server.py"), join(source, "linked.py"));
      await expect(snapshotGeneratedWorkspace(source, join(root, "snapshots"))).rejects.toThrow("symlinks");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("binds evidence to file bytes and exact spec, ignoring installed dependencies", async () => {
    const root = await mkdtemp(join(tmpdir(), "talome-browser-binding-"));
    try {
      await writeFile(join(root, "server.py"), "version one");
      const first = await fingerprintNativeWorkspace(root, spec);
      await mkdir(join(root, "node_modules"));
      await writeFile(join(root, "node_modules", "dependency.js"), "ignored");
      expect(await fingerprintNativeWorkspace(root, spec)).toEqual(first);
      await writeFile(join(root, "server.py"), "version two");
      expect((await fingerprintNativeWorkspace(root, spec)).sourceSha256).not.toBe(first.sourceSha256);
      expect((await fingerprintNativeWorkspace(root, { ...spec, revision: 2 })).specSha256).not.toBe(first.specSha256);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("rejects stale source or renderer bindings and missing viewport evidence", () => {
    expect(() => assertNativeBrowserEvidence(report(), binding, ["overview"])).not.toThrow();
    expect(() => assertNativeBrowserEvidence(report(), { ...binding, rendererBuildId: "build-two" }, ["overview"])).toThrow("does not match");
    expect(() => assertNativeBrowserEvidence(report(), { ...binding, sourceSha256: "d".repeat(64) }, ["overview"])).toThrow("does not match");
    const missing = report();
    missing.checks = missing.checks.filter((check) => check.id !== "surface:390:overview");
    expect(() => assertNativeBrowserEvidence(missing, binding, ["overview"])).toThrow("missing surface:390");
    const workflowMissing = report();
    workflowMissing.checks = workflowMissing.checks.filter((check) => check.id !== "data:empty");
    expect(() => assertNativeBrowserEvidence(workflowMissing, binding, ["overview"], true)).toThrow("missing data:empty");
  });

  it("rejects a report claiming success while any executed browser check failed", () => {
    const failed = report();
    failed.checks.push({ id: "action", status: "failed", details: "The action never refreshed data." });
    expect(() => assertNativeBrowserEvidence(failed, binding, ["overview"])).toThrow("never refreshed");
  });

  it("requires chart rendering evidence at every supported width, not only its card title", () => {
    const chartReport = report();
    expect(() => assertNativeBrowserEvidence(chartReport, binding, ["overview"], false, ["overview:trend"])).toThrow("missing chart:390:overview:trend");
    for (const width of [390, 480, 768, 1440]) chartReport.checks.push({ id: `chart:${width}:overview:trend`, status: "passed", details: "Rendered marks and accessible values checked." });
    expect(() => assertNativeBrowserEvidence(chartReport, binding, ["overview"], false, ["overview:trend"])).not.toThrow();
    chartReport.checks = chartReport.checks.filter((check) => check.id !== "chart:480:overview:trend");
    expect(() => assertNativeBrowserEvidence(chartReport, binding, ["overview"], false, ["overview:trend"])).toThrow("missing chart:480");
  });
});
