import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { parse as parseYaml } from "yaml";
import { TalomeAppSpecSchema } from "../app-specs/schema.js";
import type { ValidationCheck } from "./contracts.js";
import { hasGeneratedImplementation, listGeneratedFiles } from "./workspace-files.js";
import { validateNativeAppInBrowser } from "./browser-validation.js";
import { validateAppRuntime } from "./runtime-validation.js";
export { listGeneratedFiles } from "./workspace-files.js";

const execFileAsync = promisify(execFile);
export type ValidationCommand = (command: string, args: string[], cwd: string) => Promise<void>;
const runValidationCommand: ValidationCommand = async (command, args, cwd) => {
  await execFileAsync(command, args, { cwd, timeout: 30_000, maxBuffer: 1024 * 1024 });
};

/** Validate publishable files; supported reviewed services run only with disposable local state. */
export async function validateGeneratedApp(
  scaffoldPath: string,
  appId: string,
  blueprint: Record<string, unknown>,
  runCommand: ValidationCommand = runValidationCommand,
) {
  const files = await listGeneratedFiles(scaffoldPath);
  const validations: ValidationCheck[] = [];
  const composeFile = ["docker-compose.yml", "docker-compose.yaml"].find((file) => files.includes(file));
  validations.push({
    id: "generated-compose", label: "Generated Docker Compose is runnable", status: "failed",
    details: "A generated docker-compose.yml or docker-compose.yaml with at least one service is required.",
  });
  if (composeFile) {
    try {
      const compose = parseYaml(await readFile(join(scaffoldPath, composeFile), "utf-8"));
      if (!compose?.services || typeof compose.services !== "object" || Array.isArray(compose.services) || Object.keys(compose.services).length === 0) {
        throw new Error("Docker Compose must define at least one service.");
      }
      // Compose validates build contexts, service references, interpolation and field types.
      await runCommand("docker", ["compose", "-f", composeFile, "config", "--quiet"], scaffoldPath);
      validations[0] = { ...validations[0], status: "passed", details: `${composeFile}: docker compose config --quiet succeeded` };
    } catch (error) {
      validations[0].details = error instanceof Error ? error.message.slice(0, 800) : "Docker Compose validation failed";
    }
  }

  if ((blueprint.scaffold as { enabled?: boolean } | undefined)?.enabled) {
    const implemented = hasGeneratedImplementation(files);
    validations.push({ id: "generated-implementation", label: "Application source or assets were generated", status: implemented ? "passed" : "failed",
      details: implemented ? "Generated source or assets exist beyond deployment metadata." : "Scaffold-enabled drafts require generated application source or assets beyond deployment metadata before publishing." });
  }

  let appSpec: ReturnType<typeof TalomeAppSpecSchema.parse> | undefined;
  const hasGeneratedSpec = files.includes("talome-app.json");
  if (hasGeneratedSpec || blueprint.appSpec || blueprint.research || blueprint.experienceDesign) {
    try {
      // The generated artifact can contain newer actions and surfaces than the initial blueprint.
      appSpec = TalomeAppSpecSchema.parse(hasGeneratedSpec
        ? JSON.parse(await readFile(join(scaffoldPath, "talome-app.json"), "utf-8"))
        : blueprint.appSpec);
      if (appSpec.appId !== appId) throw new Error(`AppSpec appId must be ${appId}.`);
      validations.push({ id: "app-spec", label: "Native interaction contract is valid", status: "passed", details: `${appSpec.surfaces.length} surfaces, ${appSpec.actions.length} actions; all references resolved` });
    } catch (error) {
      appSpec = undefined;
      validations.push({ id: "app-spec", label: "Native interaction contract is valid", status: "failed", details: error instanceof Error ? error.message.slice(0, 800) : "Invalid AppSpec" });
    }
  } else {
    validations.push({ id: "app-spec", label: "Native interaction contract is valid", status: "skipped", details: "Legacy workspace has no native AppSpec; publishing retains the default Talome surface." });
  }

  // Nested UI packages are common in full-stack apps. Python/service-only apps need no TypeScript entry point.
  for (const packageFile of files.filter((file) => file === "package.json" || file.endsWith("/package.json"))) {
    const packageRoot = join(scaffoldPath, packageFile.slice(0, -"package.json".length));
    try { await access(join(packageRoot, "tsconfig.json")); } catch { continue; }
    const check: ValidationCheck = { id: `typescript:${packageFile}`, label: `TypeScript: ${packageFile}`, status: "failed" };
    try {
      const manifest = JSON.parse(await readFile(join(scaffoldPath, packageFile), "utf-8"));
      if (!manifest.devDependencies?.typescript && !manifest.dependencies?.typescript) {
        throw new Error("Declare TypeScript in this package and install dependencies before validation.");
      }
      const compiler = join(packageRoot, "node_modules", ".bin", "tsc");
      await access(compiler);
      await runCommand(compiler, ["--noEmit"], packageRoot);
      check.status = "passed";
      check.details = "tsc --noEmit succeeded";
    } catch (error) {
      check.details = error instanceof Error ? error.message.slice(0, 800) : "Typecheck failed";
    }
    validations.push(check);
  }
  if (appSpec && !validations.some((check) => check.status === "failed")) {
    validations.push(...(await validateNativeAppInBrowser(scaffoldPath, appSpec)).filter((check) => check.id !== "app-runtime"));
    validations.push(await validateAppRuntime(scaffoldPath, appSpec));
  }
  return { files, composeFile, appSpec, validations };
}
