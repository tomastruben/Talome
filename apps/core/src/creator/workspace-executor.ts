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
import { TalomeAppSpecSchema } from "../app-specs/schema.js";

const WORKSPACES_ROOT = join(homedir(), ".talome", "generated-apps");
const INTERNAL_DIR = ".talome-creator";
const SCAFFOLD_DIR = "generated-app";
const IGNORED_DIRS = new Set([".git", "node_modules", INTERNAL_DIR]);
const RESEARCH_FINDINGS_PATH = join(INTERNAL_DIR, "research", "findings.md");
const SCREEN_SPEC_PATH = join(INTERNAL_DIR, "design", "screen-spec.md");
const VALIDATION_REPORT_PATH = join(INTERNAL_DIR, "validation", "report.md");

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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- @types/node regression: ChildProcess lost .on()
    const p = proc as any;
    p.on("close", (code: number | null) => resolve({ code: code ?? 1, stdout, stderr }));
    p.on("error", (error: Error) =>
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

async function writeFileIfMissing(path: string, content: string): Promise<void> {
  try {
    await writeFile(path, content, { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
}

function renderResearchBrief(blueprint: AppBlueprint): string {
  const useCases = blueprint.research.useCases.flatMap((useCase) => [
    `### ${useCase.title}`,
    `- ID: \`${useCase.id}\``,
    `- User goal: ${useCase.userGoal}`,
    `- Outcome: ${useCase.outcome}`,
    `- Frequency: ${useCase.frequency}`,
    "",
  ]);
  const libraryNeeds = blueprint.research.libraryNeeds.flatMap((need) => [
    `- **${need.capability}:** ${need.reason}`,
    ...(need.constraints.length > 0 ? [`  Constraints: ${need.constraints.join("; ")}`] : []),
  ]);

  return [
    "# Research Brief",
    "",
    "This file records the intent supplied by the blueprint. Put verified evidence and decisions in `findings.md`.",
    "",
    "## Use cases",
    "",
    ...(useCases.length > 0 ? useCases : ["No use cases were supplied.", ""]),
    "## GitHub queries",
    "",
    ...(blueprint.research.githubQueries.length > 0
      ? blueprint.research.githubQueries.map((query) => `- ${query}`)
      : ["- No query supplied"]),
    "",
    "## Product-pattern questions",
    "",
    ...(blueprint.research.patternQuestions.length > 0
      ? blueprint.research.patternQuestions.map((question) => `- ${question}`)
      : ["- No question supplied"]),
    "",
    "## Library capabilities to investigate",
    "",
    ...(libraryNeeds.length > 0 ? libraryNeeds : ["- No additional library capability requested"]),
    "",
  ].join("\n");
}

function renderDesignBrief(blueprint: AppBlueprint): string {
  const workflows = blueprint.experienceDesign.workflows.flatMap((workflow) => [
    `### ${workflow.name}`,
    `- ID: \`${workflow.id}\``,
    `- Use case: \`${workflow.useCaseId}\``,
    `- Outcome: ${workflow.outcome}`,
    ...workflow.steps.map((step, index) => `${index + 1}. ${step}`),
    "",
  ]);
  const screens = blueprint.experienceDesign.screens.flatMap((screen) => [
    `### ${screen.name}`,
    `- ID: \`${screen.id}\``,
    `- Use cases: ${screen.useCaseIds.map((id) => `\`${id}\``).join(", ")}`,
    `- Job: ${screen.job}`,
    `- Primary action: ${screen.primaryAction}`,
    `- Pattern: ${screen.pattern}`,
    `- Component candidates: ${screen.componentCandidates.join(", ") || "to research"}`,
    `- States: ${screen.states.join(", ") || "default, loading, empty, error, compact-window"}`,
    "",
  ]);
  const direction = blueprint.experienceDesign.visualDirection;

  return [
    "# Experience Design Brief",
    "",
    `Primary use case: \`${blueprint.experienceDesign.primaryUseCaseId || "not-selected"}\``,
    "",
    "## Workflows",
    "",
    ...(workflows.length > 0 ? workflows : ["No workflows were supplied.", ""]),
    "## Screens",
    "",
    ...(screens.length > 0 ? screens : ["No screens were supplied.", ""]),
    "## Visual direction",
    "",
    ...(direction
      ? [
          `- Mode: ${direction.mode}`,
          `- Summary: ${direction.summary}`,
          `- Layout: ${direction.layout}`,
          `- Signature elements: ${direction.signatureElements.join(", ") || "none specified"}`,
          `- Motion: ${direction.motion.join(", ") || "none specified"}`,
        ]
      : ["No visual direction was supplied."]),
    "",
  ].join("\n");
}

async function writeDesignWorkflowArtifacts(
  workspaceRoot: string,
  blueprint: AppBlueprint,
): Promise<string[]> {
  const researchDir = join(workspaceRoot, INTERNAL_DIR, "research");
  const designDir = join(workspaceRoot, INTERNAL_DIR, "design");
  const validationDir = join(workspaceRoot, INTERNAL_DIR, "validation");
  await Promise.all([
    mkdir(researchDir, { recursive: true }),
    mkdir(designDir, { recursive: true }),
    mkdir(validationDir, { recursive: true }),
  ]);

  const researchBriefPath = join(researchDir, "brief.md");
  const designBriefPath = join(designDir, "brief.md");
  const findingsPath = join(workspaceRoot, RESEARCH_FINDINGS_PATH);
  const screenSpecPath = join(workspaceRoot, SCREEN_SPEC_PATH);
  const reportPath = join(workspaceRoot, VALIDATION_REPORT_PATH);

  await writeFile(researchBriefPath, renderResearchBrief(blueprint));
  await writeFile(designBriefPath, renderDesignBrief(blueprint));
  await writeFileIfMissing(findingsPath, [
    "# Research Findings",
    "",
    "Status: pending",
    "",
    "Complete this before implementing application UI. Use exact URLs and verified facts.",
    "",
    "## Candidates",
    "",
    "| Candidate | Exact URL/ref | License | Maintenance evidence | Talome fit | Decision | Reusable part |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    "| [pending] | [pending] | [pending] | [pending] | [pending] | reuse / adapt / inspiration / reject | [pending] |",
    "",
    "## Screen-pattern findings",
    "",
    "- [pending]",
    "",
    "## Final source and library choices",
    "",
    "- [pending]",
    "",
  ].join("\n"));
  await writeFileIfMissing(screenSpecPath, [
    "# Screen Specification",
    "",
    "Status: pending",
    "",
    "Resolve the design brief against the research findings before writing application UI.",
    "",
    renderDesignBrief(blueprint),
    "## Research-driven changes",
    "",
    "- [pending]",
    "",
    "## Accepted component and container model",
    "",
    "- [pending]",
    "",
  ].join("\n"));
  await writeFileIfMissing(reportPath, [
    "# Validation Report",
    "",
    "Status: pending",
    "",
    "## Primary workflow exercised",
    "",
    "- [pending]",
    "",
    "## Reference/render comparison",
    "",
    "| Check | Reference or specification evidence | Rendered evidence | Result/fix |",
    "| --- | --- | --- | --- |",
    "| 1 | [pending] | [pending] | [pending] |",
    "| 2 | [pending] | [pending] | [pending] |",
    "| 3 | [pending] | [pending] | [pending] |",
    "| 4 | [pending] | [pending] | [pending] |",
    "| 5 | [pending] | [pending] | [pending] |",
    "",
    "## Responsive, state, accessibility, and assistant checks",
    "",
    "- [pending]",
    "",
  ].join("\n"));

  return [researchBriefPath, findingsPath, designBriefPath, screenSpecPath, reportPath];
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
    "Follow the staged workflow: complete evidence-backed research in .talome-creator/research/findings.md, then resolve .talome-creator/design/screen-spec.md, then build, then complete .talome-creator/validation/report.md.",
    "Do not write application UI before the research and screen-spec statuses are complete, and do not claim completion before the validation report is complete.",
    "When researching GitHub projects or libraries, use exact verified sources and record URL/ref, license, maintenance evidence, compatibility, decision, and the exact reusable part. Never invent a repository or fact when network access is unavailable.",
    "Treat blueprint.appSpec as the source of truth for native screens, data sources, actions, and assistant capabilities.",
    "Do not reimplement AppSpec blocks with bespoke cards or styling; Talome renders them with its native component registry.",
    "If you build a supplementary external UI, keep talome-app.json in sync and preserve all declared assistant actions.",
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

interface ArtifactCheckOptions {
  id: string;
  label: string;
  relativePath: string;
  minimumComparisonRows?: number;
  requiredPatterns?: Array<{ pattern: RegExp; label: string }>;
}

async function validateArtifact(
  workspaceRoot: string,
  options: ArtifactCheckOptions,
): Promise<ValidationCheck> {
  try {
    const content = await readFile(join(workspaceRoot, options.relativePath), "utf-8");
    const isComplete = /^Status:\s*complete\s*$/im.test(content);
    const hasPendingMarkers = /\[pending\]/i.test(content);
    const comparisonRows = content.match(/^\|\s*\d+\s*\|/gm)?.length ?? 0;
    const hasRequiredRows = comparisonRows >= (options.minimumComparisonRows ?? 0);
    const missingRequiredEvidence = (options.requiredPatterns ?? [])
      .filter(({ pattern }) => !pattern.test(content))
      .map(({ label }) => label);
    const hasRequiredEvidence = missingRequiredEvidence.length === 0;
    const passed = isComplete && !hasPendingMarkers && hasRequiredRows && hasRequiredEvidence;

    return {
      id: options.id,
      label: options.label,
      status: passed ? "passed" : "failed",
      details: passed
        ? `${options.relativePath} is complete`
        : `${options.relativePath} must have Status: complete, no [pending] markers${options.minimumComparisonRows ? `, at least ${options.minimumComparisonRows} comparison rows` : ""}${missingRequiredEvidence.length ? `, and evidence for ${missingRequiredEvidence.join(", ")}` : ""}`,
    };
  } catch {
    return {
      id: options.id,
      label: options.label,
      status: "failed",
      details: `${options.relativePath} is missing`,
    };
  }
}

async function validateResearchArtifact(workspaceRoot: string): Promise<ValidationCheck> {
  const baseCheck = await validateArtifact(workspaceRoot, {
    id: "research-evidence",
    label: "Research evidence and reuse decisions are complete",
    relativePath: RESEARCH_FINDINGS_PATH,
  });
  if (baseCheck.status !== "passed") return baseCheck;

  const content = await readFile(join(workspaceRoot, RESEARCH_FINDINGS_PATH), "utf-8");
  const hasEvidenceRow = content.split("\n").some((line) => {
    if (!line.trim().startsWith("|") || /^\|\s*(Candidate|---)/i.test(line)) return false;
    const cells = line.split("|").slice(1, -1).map((cell) => cell.trim());
    if (cells.length < 7) return false;
    const [candidate, exactSource, license, maintenance, fit, decision, reusablePart] = cells;
    return Boolean(
      candidate &&
      /^(https?:\/\/|local:|\.talome-creator\/sources\/)/i.test(exactSource) &&
      license &&
      maintenance &&
      fit &&
      /^(reuse|adapt|inspiration|reject)$/i.test(decision) &&
      reusablePart,
    );
  });

  return hasEvidenceRow
    ? baseCheck
    : {
        ...baseCheck,
        status: "failed",
        details: `${RESEARCH_FINDINGS_PATH} needs at least one evidence row with an exact source/ref, license, maintenance signal, Talome fit, explicit decision, and reusable part`,
      };
}

export async function validateDesignArtifacts(workspaceRoot: string): Promise<ValidationCheck[]> {
  return Promise.all([
    validateResearchArtifact(workspaceRoot),
    validateArtifact(workspaceRoot, {
      id: "screen-spec",
      label: "Research-resolved screen specification is complete",
      relativePath: SCREEN_SPEC_PATH,
    }),
    validateArtifact(workspaceRoot, {
      id: "rendered-validation",
      label: "Rendered workflow validation is complete",
      relativePath: VALIDATION_REPORT_PATH,
      minimumComparisonRows: 5,
      requiredPatterns: [{ pattern: /dark(?:\s+mode|-mode|\s+theme)/i, label: "dark mode" }],
    }),
  ]);
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

  const appSpecResult = blueprint.appSpec
    ? TalomeAppSpecSchema.safeParse(blueprint.appSpec)
    : null;
  validations.push({
    id: "app-spec",
    label: "Native Talome AppSpec is valid",
    status: appSpecResult?.success ? "passed" : "failed",
    details: appSpecResult?.success
      ? `${appSpecResult.data.surfaces.length} surface(s), ${appSpecResult.data.actions.length} action(s)`
      : appSpecResult
        ? appSpecResult.error.issues.slice(0, 3).map((issue) => issue.message).join("; ")
        : "Blueprint has no AppSpec",
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
  validations.push(...await validateDesignArtifacts(workspaceRoot));

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
  designArtifacts: string[];
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

  if (options.blueprint.appSpec) {
    await writeFile(
      join(scaffoldPath, "talome-app.json"),
      JSON.stringify(options.blueprint.appSpec, null, 2),
    );
  }

  await writeInstructionSnapshots(
    workspaceRoot,
    options.instructionPack,
    options.blueprint,
    options.talomeReferences,
  );
  const designArtifacts = await writeDesignWorkflowArtifacts(workspaceRoot, options.blueprint);

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
    "## Required design gates",
    "",
    "1. Complete `.talome-creator/research/findings.md` with verified source, library, license, maintenance, compatibility, and reuse evidence",
    "2. Complete `.talome-creator/design/screen-spec.md` with research-resolved workflows, screens, states, visual direction, and component choices",
    "3. Implement the real primary workflow in `generated-app/`",
    "4. Exercise the rendered and assistant workflows, then complete `.talome-creator/validation/report.md` with at least five comparison checks",
    "",
    "Do not begin application UI before gates 1 and 2 are complete. Do not claim completion while gate 4 is pending.",
    "",
    "## Output",
    "",
    `Write all generated files to the \`${SCAFFOLD_DIR}/\` directory.`,
    "Preserve `generated-app/talome-app.json`; it is the native Talome experience contract.",
    "Use only component IDs declared by the AppSpec contract. Native UI is rendered by Talome, not copied into this workspace.",
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

  return { workspaceRoot, scaffoldPath, taskPrompt, sourceSnapshots, designArtifacts, beforeSnapshot };
}

export async function completeWorkspace(
  prepared: PreparedWorkspace,
  app: GeneratedApp,
  blueprint: AppBlueprint,
): Promise<{ workspace: WorkspaceSummary; validations: ValidationCheck[] }> {
  const { workspaceRoot, scaffoldPath, sourceSnapshots, designArtifacts, beforeSnapshot } = prepared;
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
    designArtifacts: designArtifacts.map((path) => path.replace(`${workspaceRoot}/`, "")),
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
