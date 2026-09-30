import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import type { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDefaultAppSpec } from "../app-specs/schema.js";
import { assertRuntimeEvidence, RuntimeReportSchema, validateAppRuntime } from "../creator/runtime-validation.js";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const spec = createDefaultAppSpec({ appId: "probe-fixture", name: "Probe fixture", description: "Disposable service verification" });
const roots: string[] = [];
async function fixture(descriptor: unknown = { version: 1, adapter: "stopwatch-v1" }) {
  const root = await mkdtemp(join(tmpdir(), "talome-runtime-test-")); roots.push(root);
  const path = join(root, "generated-app"); await mkdir(path);
  await writeFile(join(path, "talome-runtime-probe.json"), JSON.stringify(descriptor));
  await writeFile(join(path, "talome-app.json"), JSON.stringify(spec));
  for (const file of ["server.py", "stopwatch.py"]) await writeFile(join(path, file), await readFile(join(projectRoot, "apps/stopwatch", file)));
  return path;
}
const ids = ["fresh-state", "invalid-actions", "start-and-label", "elapsed-and-lap", "pause", "restart-persistence", "running-recovery", "confirmed-reset", "isolation"];
function report(binding: unknown) { return { version: 1, scope: "app-runtime", adapter: "stopwatch-v1", binding, generatedAt: new Date().toISOString(), status: "passed", checks: ids.map((id) => ({ id, status: "passed", details: "Executed." })), unverified: ["Production integration"] }; }
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

describe("reviewed real service workflow validation", () => {
  it("executes real HTTP effects and restart persistence without copying workspace imports", async () => {
    const path = await fixture();
    await writeFile(join(path, "json.py"), 'raise RuntimeError("Workspace import must never execute")');
    await writeFile(join(path, ".env"), "STOPWATCH_DATA_PATH=/must-not-use-live-state\n");
    const check = await validateAppRuntime(path, spec);
    expect(check, check.details).toMatchObject({ id: "app-runtime", status: "passed", scope: "app-runtime" });
    const evidence = RuntimeReportSchema.parse(JSON.parse(await readFile(check.evidencePath!, "utf8")));
    expect(evidence.checks.map((item) => item.id)).toEqual(ids);
    expect(evidence.binding.fileCount).toBe(6);
  }, 30_000);

  it("does not claim verification when no probe is declared", async () => {
    const path = await fixture(); await rm(join(path, "talome-runtime-probe.json"));
    const execute = vi.fn();
    expect(await validateAppRuntime(path, spec, { execute })).toMatchObject({ status: "skipped", details: expect.stringContaining("remain unverified") });
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([{ version: 1, adapter: "arbitrary-command", command: "curl example.com" }, { version: 1, adapter: "stopwatch-v1", command: "python unsafe.py" }])("rejects unknown or extended declarations before execution", async (descriptor) => {
    const execute = vi.fn();
    expect((await validateAppRuntime(await fixture(descriptor), spec, { execute })).status).toBe("failed");
    expect(execute).not.toHaveBeenCalled();
  });

  it.each(["missing", "modified"])("fails closed for %s reviewed source", async (kind) => {
    const path = await fixture();
    if (kind === "missing") await rm(join(path, "server.py"));
    else await writeFile(join(path, "server.py"), "print('forged evidence')");
    const execute = vi.fn();
    expect((await validateAppRuntime(path, spec, { execute })).status).toBe("failed");
    expect(execute).not.toHaveBeenCalled();
  });

  it.each(["python3 is missing", "Service process crashed", "Runtime timed out"])("fails closed when %s", async (message) => {
    expect(await validateAppRuntime(await fixture(), spec, { execute: async () => { throw new Error(message); } })).toMatchObject({ status: "failed", details: message });
  });

  it("reports missing Python from the actual runner rather than accepting workspace evidence", async () => {
    const path = await fixture();
    await writeFile(join(path, "runtime-report.json"), JSON.stringify({ status: "passed" }));
    const check = await validateAppRuntime(path, spec, { execute: (input) => new Promise((resolveOutput, reject) => {
      const child = spawn(process.execPath, [join(projectRoot, "scripts/validate-stopwatch-runtime.mjs")], {
        env: { PATH: "/talome-probe-no-executables" }, stdio: ["pipe", "pipe", "pipe"],
      });
      let output = "";
      child.stdout.on("data", (chunk) => { output += chunk; });
      (child as unknown as EventEmitter).once("error", reject);
      (child as unknown as EventEmitter).once("close", () => resolveOutput(output));
      child.stdin.end(JSON.stringify(input));
    }) });
    expect(check).toMatchObject({ status: "failed", details: expect.stringContaining("ENOENT") });
  });

  it("rejects files changed during execution even when the report claims success", async () => {
    const path = await fixture();
    const check = await validateAppRuntime(path, spec, { execute: async (input) => {
      await writeFile(join(path, "new.py"), "changed");
      return JSON.stringify(report((input as { binding: unknown }).binding));
    } });
    expect(check).toMatchObject({ status: "failed", details: expect.stringContaining("changed during runtime") });
  });

  it("requires current binding, every workflow marker and no failed subchecks", () => {
    const binding = { appId: spec.appId, sourceSha256: "a".repeat(64), specSha256: "b".repeat(64), fileCount: 4, adapterSha256: "c".repeat(64), harnessSha256: "d".repeat(64) };
    const valid = RuntimeReportSchema.parse(report(binding));
    expect(() => assertRuntimeEvidence(valid, binding)).not.toThrow();
    expect(() => assertRuntimeEvidence(valid, { ...binding, sourceSha256: "e".repeat(64) })).toThrow("does not match");
    expect(() => assertRuntimeEvidence({ ...valid, checks: valid.checks.slice(1) }, binding)).toThrow("missing fresh-state");
    expect(() => assertRuntimeEvidence({ ...valid, checks: [...valid.checks, { id: "extra", status: "failed", details: "persistence failed" }] }, binding)).toThrow("persistence failed");
  });
});
