import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  cp,
  mkdir,
  readFile,
  readdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { statSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import type {
  AppBlueprint,
  GeneratedApp,
  SourceReference,
  ValidationCheck,
  WorkspaceSummary,
} from "./contracts.js";
import type { InstructionPack, ReferenceSnapshot } from "./instructions.js";
import { runClaudeCode } from "../ai/claude-runner.js";

const WORKSPACES_ROOT = join(homedir(), ".talome", "generated-apps");
const INTERNAL_DIR = ".talome-creator";
const SCAFFOLD_DIR = "generated-app";
const IGNORED_DIRS = new Set([".git", "node_modules", INTERNAL_DIR]);

interface ExecuteWorkspaceOptions {
  app: GeneratedApp;
  blueprint: AppBlueprint;
  sources: SourceReference[];
  instructionPack: InstructionPack;
  talomeReferences: ReferenceSnapshot[];
  userDescription?: string;
}

export interface FileSnapshot {
  path: string;
  hash: string;
}

function sanitizeName(input: string): string {
  return input.replace(/[^a-zA-Z0-9._-]+/g, "-");
}

function runCommand(
  command: string,
  args: string[],
  cwd: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    const proc = spawn(command, args, { cwd, env: process.env, shell: false });
    proc.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    proc.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    proc.on("error", (error) =>
      resolve({ code: 1, stdout, stderr: `${stderr}\n${error.message}`.trim() }),
    );
  });
}

async function listWorkspaceFiles(rootPath: string, relativePath = ""): Promise<FileSnapshot[]> {
  const target = join(rootPath, relativePath);
  const entries = await readdir(target, { withFileTypes: true });
  const files: FileSnapshot[] = [];

  for (const entry of entries) {
    if (IGNORED_DIRS.has(entry.name)) continue;
    const nextRelative = relativePath ? join(relativePath, entry.name) : entry.name;
    if (entry.isDirectory()) {
      files.push(...await listWorkspaceFiles(rootPath, nextRelative));
      continue;
    }
    const content = await readFile(join(rootPath, nextRelative));
    files.push({
      path: nextRelative,
      hash: createHash("sha1").update(content).digest("hex"),
    });
  }

  return files;
}

async function materializeSourceSnapshots(workspaceRoot: string, sources: SourceReference[]): Promise<string[]> {
  const snapshotsDir = join(workspaceRoot, INTERNAL_DIR, "sources");
  await mkdir(snapshotsDir, { recursive: true });
  const written: string[] = [];

  for (const source of sources) {
    if (source.kind === "public-repo" && source.repoUrl) {
      const repoDir = join(snapshotsDir, sanitizeName(basename(source.repoUrl, ".git")));
      const cloneResult = await runCommand(
        "git",
        ["clone", "--depth", "1", ...(source.ref ? ["--branch", source.ref] : []), source.repoUrl, repoDir],
        workspaceRoot,
      );

      if (cloneResult.code === 0) {
        written.push(repoDir);
      } else {
        const errorPath = join(
          snapshotsDir,
          `${sanitizeName(basename(source.repoUrl))}-clone-error.txt`,
        );
        await writeFile(errorPath, cloneResult.stderr || cloneResult.stdout || "Failed to clone repo");
        written.push(errorPath);
      }
      continue;
    }

    if (source.composePath) {
      const sourceDir = join(snapshotsDir, sanitizeName(source.appId || source.label));
      await mkdir(sourceDir, { recursive: true });
      await cp(source.composePath, join(sourceDir, "docker-compose.yml"));

      const manifestPath = join(source.composePath, "..", "manifest.json");
      try {
        await cp(manifestPath, join(sourceDir, "manifest.json"));
      } catch {
        // best effort
      }
      written.push(sourceDir);
    }
  }

  await writeFile(join(snapshotsDir, "sources.json"), JSON.stringify(sources, null, 2));
  written.push(join(snapshotsDir, "sources.json"));
  return written;
}

async function writeInstructionSnapshots(
  workspaceRoot: string,
  instructionPack: InstructionPack,
  blueprint: AppBlueprint,
  talomeReferences: ReferenceSnapshot[],
): Promise<void> {
  const internalRoot = join(workspaceRoot, INTERNAL_DIR);
  const instructionsDir = join(internalRoot, "instructions");
  const referencesDir = join(internalRoot, "references");

  await mkdir(internalRoot, { recursive: true });
  await mkdir(instructionsDir, { recursive: true });
  await mkdir(referencesDir, { recursive: true });

  await writeFile(join(internalRoot, "blueprint.json"), JSON.stringify(blueprint, null, 2));

  for (const [name, content] of Object.entries(instructionPack.documents)) {
    await writeFile(join(instructionsDir, name), content);
  }

  for (const reference of talomeReferences) {
    const suffix = extname(reference.relativePath) || ".txt";
    const name = `${sanitizeName(reference.title.toLowerCase())}${suffix}`;
    await writeFile(join(referencesDir, name), reference.content);
  }
}

export function buildClaudeTask(app: GeneratedApp, blueprint: AppBlueprint, userDescription?: string): string {
  const sourceHint =
    blueprint.sourceReferences.length > 0
      ? "Study the source snapshots in .talome-creator/sources before inventing new structure."
      : "No strong source snapshot is present, so generate from scratch while staying realistic.";

  const descriptionBlock = userDescription
    ? `The user's original request was: "${userDescription}".`
    : "";

  return [
    `You are helping the user create "${app.name}" in the "${SCAFFOLD_DIR}" directory.`,
    descriptionBlock,
    "This is an interactive session — the user is watching the terminal.",
    "If the user's description is vague or missing important details (e.g. which Docker image to use, what ports to expose, specific features they want, authentication preferences, or storage needs), ask them before proceeding. Keep questions concise — one or two at a time.",
    "Once you have enough clarity, read the blueprint in .talome-creator/blueprint.json.",
    "Read .talome-creator/system-context.json for installed apps, used ports, and system info — avoid port conflicts.",
    "Read every markdown file in .talome-creator/instructions before making changes.",
    "Study the files in .talome-creator/references and mirror Talome's design language.",
    sourceHint,
    "Prefer coherent shadcn-based flows and reuse the same interaction grammar as Talome.",
    "Do not modify files outside this workspace.",
    "When the app is ready, use the Talome MCP tools (install_app, start_app, check_service_health) to install and start it so the user can see it running immediately.",
    "When finished, the workspace should be ready for follow-up tweaks with minimal churn.",
  ].filter(Boolean).join(" ");
}

function mergeSnapshots(before: FileSnapshot[], after: FileSnapshot[]): string[] {
  const beforeMap = new Map(before.map((item) => [item.path, item.hash]));
  return after
    .filter((item) => beforeMap.get(item.path) !== item.hash)
    .map((item) => item.path)
    .sort();
}

export async function validateWorkspace(
  workspaceRoot: string,
  scaffoldPath: string,
  app: GeneratedApp,
  blueprint: AppBlueprint,
  sourceSnapshots: string[],
): Promise<{ validations: ValidationCheck[]; entryFiles: string[]; fileCount: number }> {
  const validations: ValidationCheck[] = [];
  let files = await listWorkspaceFiles(workspaceRoot);
  files = files.filter((file) => !file.path.startsWith(`${INTERNAL_DIR}/`));

  const scaffoldFiles = files
    .map((file) => file.path)
    .filter((file) => file.startsWith(`${SCAFFOLD_DIR}/`));

  const packageJsonPath = join(scaffoldPath, "package.json");
  const tsconfigPath = join(scaffoldPath, "tsconfig.json");
  const appEntryCandidates = [
    join(scaffoldPath, "app", "page.tsx"),
    join(scaffoldPath, "src", "app", "page.tsx"),
    join(scaffoldPath, "src", "index.ts"),
    join(scaffoldPath, "index.ts"),
  ];

  validations.push({
    id: "compose-shape",
    label: "Docker app definition is populated",
    status: app.services.length > 0 ? "passed" : "failed",
    details: `${app.services.length} service(s) in generated definition`,
  });

  validations.push({
    id: "scaffold-files",
    label: "Scaffold files were generated",
    status: blueprint.scaffold.enabled
      ? scaffoldFiles.length > 0
        ? "passed"
        : "failed"
      : "skipped",
    details: blueprint.scaffold.enabled
      ? `${scaffoldFiles.length} scaffold file(s) detected`
      : "Scaffold generation disabled for this request",
  });

  const presentEntryFiles: string[] = [];
  for (const candidate of appEntryCandidates) {
    try {
      await stat(candidate);
      presentEntryFiles.push(candidate.replace(`${workspaceRoot}/`, ""));
    } catch {
      // ignore
    }
  }

  validations.push({
    id: "entry-file",
    label: "Scaffold has an entry file",
    status: blueprint.scaffold.enabled
      ? presentEntryFiles.length > 0
        ? "passed"
        : "failed"
      : "skipped",
    details:
      presentEntryFiles[0] ||
      (blueprint.scaffold.enabled ? "No common entry file detected in generated-app" : "Scaffold not required"),
  });

  validations.push({
    id: "source-provenance",
    label: "Source provenance is recorded",
    status: sourceSnapshots.length > 0 ? "passed" : "skipped",
    details: sourceSnapshots.length > 0 ? `${sourceSnapshots.length} source snapshot artifact(s)` : "No source was reused",
  });

  try {
    parseYaml(
      ["services:", ...app.services.map((service) => `  ${service.name}: { image: ${JSON.stringify(service.image)} }`)].join("\n"),
    );
    validations.push({
      id: "compose-parse",
      label: "Generated compose data is parseable",
      status: "passed",
      details: "Compose-like YAML rendered successfully",
    });
  } catch (error) {
    validations.push({
      id: "compose-parse",
      label: "Generated compose data is parseable",
      status: "failed",
      details: error instanceof Error ? error.message : "Compose parse failed",
    });
  }

  if (blueprint.designAlignment.referencePaths.length === 0) {
    validations.push({
      id: "talome-design",
      label: "Talome design references are present",
      status: "failed",
      details: "Blueprint did not carry Talome design references",
    });
  } else if (scaffoldFiles.length === 0) {
    validations.push({
      id: "talome-design",
      label: "Talome design references are present",
      status: "skipped",
      details: "No scaffold files were produced to inspect",
    });
  } else {
    const tsxFiles = scaffoldFiles.filter((file) => file.endsWith(".tsx")).slice(0, 10);
    let foundSignal = false;
    for (const file of tsxFiles) {
      const content = await readFile(join(workspaceRoot, file), "utf-8");
      if (content.includes("@/components/ui/") || content.includes("HugeiconsIcon")) {
        foundSignal = true;
        break;
      }
    }
    validations.push({
      id: "talome-design",
      label: "Scaffold shows Talome-style component usage",
      status: foundSignal ? "passed" : "skipped",
      details: foundSignal
        ? "Detected Talome-aligned component imports in scaffold"
        : "No direct Talome component signal detected; blueprint references still included",
    });
  }

  let typecheckStatus: ValidationCheck = {
    id: "typescript",
    label: "TypeScript validation",
    status: "skipped",
    details: "Typecheck skipped because no installable TypeScript project was detected",
  };

  try {
    await stat(packageJsonPath);
    await stat(tsconfigPath);
    const typecheck = await runCommand("pnpm", ["exec", "tsc", "--noEmit"], scaffoldPath);
    typecheckStatus =
      typecheck.code === 0
        ? {
            id: "typescript",
            label: "TypeScript validation",
            status: "passed",
            details: "tsc --noEmit succeeded",
          }
        : {
            id: "typescript",
            label: "TypeScript validation",
            status: "failed",
            details: (typecheck.stderr || typecheck.stdout || "Typecheck failed").slice(0, 400),
          };
  } catch {
    // keep skipped status
  }
  validations.push(typecheckStatus);

  return {
    validations,
    entryFiles: presentEntryFiles,
    fileCount: files.length,
  };
}

export interface PreparedWorkspace {
  workspaceRoot: string;
  scaffoldPath: string;
  taskPrompt: string;
  sourceSnapshots: string[];
  beforeSnapshot: FileSnapshot[];
}

export async function prepareWorkspace(
  options: ExecuteWorkspaceOptions,
): Promise<PreparedWorkspace> {
  const workspaceRoot = join(WORKSPACES_ROOT, options.app.id);
  const scaffoldPath = join(workspaceRoot, SCAFFOLD_DIR);
  const internalRoot = join(workspaceRoot, INTERNAL_DIR);

  await mkdir(join(internalRoot, "runs"), { recursive: true });
  await mkdir(scaffoldPath, { recursive: true });

  await writeInstructionSnapshots(
    workspaceRoot,
    options.instructionPack,
    options.blueprint,
    options.talomeReferences,
  );

  // Write CLAUDE.md so Claude Code has context on every session (new or resumed)
  const claudeMd = [
    `# ${options.app.name}`,
    "",
    `App ID: \`${options.app.id}\``,
    "",
    `This workspace was created by Talome's app creator.`,
    "",
    "## Before making any changes",
    "",
    "1. Read `.talome-creator/blueprint.json` — the structured app spec",
    "2. Read `.talome-creator/system-context.json` — installed apps, used ports, system info",
    "3. Read every file in `.talome-creator/instructions/` — coding and design rules",
    "4. Study `.talome-creator/references/` — Talome source snapshots to mirror",
    options.sources.length > 0
      ? "5. Study `.talome-creator/sources/` — existing app sources to adapt from"
      : "",
    "",
    "## Output",
    "",
    `Write all generated files to the \`${SCAFFOLD_DIR}/\` directory.`,
    "Do not modify files outside this workspace.",
    "",
    "## Docker Compose rules for scaffold apps",
    "",
    "If the app includes custom source code (a Dockerfile, server code, frontend build, etc.):",
    "- Use `build: .` or `build: ./path` in docker-compose.yml so Docker builds from the scaffold",
    "- Add `working_dir` and `command` directives when the container needs to run a custom entrypoint",
    "- The generated docker-compose.yml in this workspace is the FINAL compose — it will be copied as-is to the install directory",
    "- Do NOT rely on any compose file from .talome-creator/sources/ being merged — your compose must be self-contained",
    "",
    "## After building",
    "",
    "Once the app's docker-compose.yml and manifest are ready, use the Talome MCP tools to install and start it:",
    "",
    `1. \`install_app\` with appId \`${options.app.id}\` and storeId \`user-apps\` to install the app`,
    `2. \`start_app\` with appId \`${options.app.id}\` to start the containers`,
    `3. \`check_service_health\` to verify the app is running correctly`,
    "",
    "If anything fails, use `get_container_logs` and `diagnose_app` to troubleshoot.",
    "",
    "## Interaction",
    "",
    "This is an interactive session. If the user's request is unclear, ask before building.",
    "Keep questions concise — one or two at a time.",
  ].filter(Boolean).join("\n");
  await writeFile(join(workspaceRoot, "CLAUDE.md"), claudeMd);

  // Write .mcp.json so Claude Code can access Talome MCP tools (install_app, etc.)
  const talomeRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
  // Detect Docker socket — honour DOCKER_SOCKET / DOCKER_HOST, then try common paths
  const dockerSocket = process.env.DOCKER_SOCKET
    ?? (process.env.DOCKER_HOST?.startsWith("unix://") ? process.env.DOCKER_HOST.slice(7) : undefined)
    ?? [
      join(homedir(), ".orbstack/run/docker.sock"),
      join(homedir(), ".docker/run/docker.sock"),
      "/var/run/docker.sock",
    ].find((p) => { try { return statSync(p).isSocket?.() ?? true; } catch { return false; } })
    ?? "/var/run/docker.sock";

  const mcpConfig = {
    mcpServers: {
      talome: {
        type: "stdio",
        command: join(talomeRoot, "apps/core/node_modules/.bin/tsx"),
        args: [join(talomeRoot, "apps/core/src/mcp-stdio.ts")],
        env: {
          DATABASE_PATH: join(talomeRoot, "apps/core/data/talome.db"),
          DOCKER_SOCKET: dockerSocket,
          NODE_ENV: "production",
        },
      },
    },
  };
  await writeFile(join(workspaceRoot, ".mcp.json"), JSON.stringify(mcpConfig, null, 2));

  // Write system context so Claude Code can make informed decisions about
  // ports, existing apps, and system configuration
  try {
    const { db, schema } = await import("../db/index.js");
    const installedApps = db.select().from(schema.installedApps).all();
    const catalogEntries = db.select().from(schema.appCatalog).all();

    const usedPorts = new Set<number>();
    for (const app of installedApps) {
      const entry = catalogEntries.find(
        (c) => c.appId === app.appId && c.storeSourceId === app.storeSourceId,
      );
      if (entry) {
        const ports = JSON.parse(entry.ports) as { host: number }[];
        for (const p of ports) usedPorts.add(p.host);
      }
    }

    const systemContext = {
      installedApps: installedApps.map((a) => ({
        id: a.appId,
        status: a.status,
        storeId: a.storeSourceId,
      })),
      usedPorts: Array.from(usedPorts).sort((a, b) => a - b),
      reservedPorts: [
        Number(process.env.DASHBOARD_PORT) || 3000,
        Number(process.env.CORE_PORT) || 4000,
      ],
      dockerSocket,
      platform: process.platform,
      arch: process.arch,
    };

    await writeFile(
      join(internalRoot, "system-context.json"),
      JSON.stringify(systemContext, null, 2),
    );
  } catch {
    // Non-critical — Claude Code can still function without this
  }

  const sourceSnapshots = await materializeSourceSnapshots(workspaceRoot, options.sources);
  const beforeSnapshot = await listWorkspaceFiles(workspaceRoot);
  const taskPrompt = buildClaudeTask(options.app, options.blueprint, options.userDescription);

  return { workspaceRoot, scaffoldPath, taskPrompt, sourceSnapshots, beforeSnapshot };
}

export async function completeWorkspace(
  prepared: PreparedWorkspace,
  app: GeneratedApp,
  blueprint: AppBlueprint,
): Promise<{ workspace: WorkspaceSummary; validations: ValidationCheck[] }> {
  const { workspaceRoot, scaffoldPath, sourceSnapshots, beforeSnapshot } = prepared;
  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const runLogPath = join(workspaceRoot, INTERNAL_DIR, "runs", `${runId}.json`);

  const after = await listWorkspaceFiles(workspaceRoot);
  const changedFiles = mergeSnapshots(beforeSnapshot, after);
  const validation = await validateWorkspace(
    workspaceRoot,
    scaffoldPath,
    app,
    blueprint,
    sourceSnapshots,
  );

  await writeFile(
    runLogPath,
    JSON.stringify(
      {
        appId: app.id,
        createdAt: new Date().toISOString(),
        changedFiles,
        validations: validation.validations,
      },
      null,
      2,
    ),
  );

  const workspace: WorkspaceSummary = {
    appId: app.id,
    rootPath: workspaceRoot,
    scaffoldPath,
    fileCount: validation.fileCount,
    entryFiles: validation.entryFiles,
    sourceSnapshots: sourceSnapshots.map((path) => path.replace(`${workspaceRoot}/`, "")),
    generatedWithClaudeCode: changedFiles.length > 0,
    runLogPath,
  };

  return { workspace, validations: validation.validations };
}

export async function executeWorkspaceGeneration(
  options: ExecuteWorkspaceOptions,
): Promise<{ workspace: WorkspaceSummary; validations: ValidationCheck[] }> {
  const prepared = await prepareWorkspace(options);

  const claudeResult = await runClaudeCode({
    task: prepared.taskPrompt,
    cwd: prepared.workspaceRoot,
    mode: "headless",
  });
  const claudeExitOk = claudeResult.success || Boolean(claudeResult.output);

  const result = await completeWorkspace(prepared, options.app, options.blueprint);

  return {
    workspace: {
      ...result.workspace,
      generatedWithClaudeCode: claudeExitOk,
    },
    validations: [
      ...result.validations,
      {
        id: "claude-execution",
        label: "Claude Code workspace run",
        status: claudeExitOk ? "passed" : "failed",
        details: claudeExitOk
          ? `${result.validations.find((v) => v.id === "scaffold-files")?.details || "Files generated"}`
          : (claudeResult.error || "Claude Code did not produce output").slice(0, 400),
      },
    ],
  };
}
