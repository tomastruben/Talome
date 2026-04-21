// ── AI-Assisted Crash Diagnosis ──────────────────────────────────────────────
//
// Two paths, matching the pattern from agent-loop/remediation.ts:
//   1. Claude Code CLI (preferred, $0 cost via subscription)
//   2. Anthropic API fallback (Haiku, ~$0.001/call)
//
// The supervisor calls this when a process has crashed 3+ times in 5 minutes
// and no recent evolution change explains it.

import { spawn } from "node:child_process";
import Database from "better-sqlite3";
import type { DiagnosticsBundle, DiagnosisResult } from "./types.js";

// ── Claude Code availability check ──────────────────────────────────────────

let _claudeAvailable: boolean | null = null;

async function isClaudeCodeAvailable(): Promise<boolean> {
  if (_claudeAvailable !== null) return _claudeAvailable;
  try {
    const result = await new Promise<{ code: number }>((resolve) => {
      const proc = spawn("claude", ["--version"], { shell: false });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- ChildProcess type lacks .on() in newer @types/node
      const p = proc as any;
      p.on("close", (code: number | null) => resolve({ code: code ?? 1 }));
      p.on("error", () => resolve({ code: 1 }));
    });
    _claudeAvailable = result.code === 0;
  } catch {
    _claudeAvailable = false;
  }
  return _claudeAvailable;
}

// ── Diagnosis prompt ─────────────────────────────────────────────────────────

function buildDiagnosisPrompt(bundle: DiagnosticsBundle): string {
  return `You are Talome's process supervisor AI. A Talome process has crashed repeatedly and needs diagnosis.

CRASHED PROCESS: ${bundle.processName}
EXIT CODE: ${bundle.exitCode}
EXIT SIGNAL: ${bundle.exitSignal ?? "none"}
CRASH COUNT: ${bundle.crashCount} times in the last 5 minutes

LAST LINES OF OUTPUT:
\`\`\`
${bundle.logTail.slice(-4000)}
\`\`\`

RECENT GIT CHANGES (last 5 commits):
${bundle.recentCommits}

UNCOMMITTED CHANGES:
${bundle.uncommittedChanges || "None"}

SYSTEM RESOURCES:
- CPU: ${bundle.systemResources.cpu}%
- Memory: ${bundle.systemResources.memPercent}%
- Disk: ${bundle.systemResources.diskPercent}%

RECENT EVOLUTION RUNS:
${bundle.recentEvolutionRuns}

RECENT AUDIT LOG:
${bundle.recentAuditEntries}

Analyze this crash and respond with EXACTLY this format:
ROOT CAUSE: <one-line summary>
CONFIDENCE: <low|medium|high>
RECOMMENDED ACTION: <restart|revert_evolution|revert_uncommitted|notify_user|none>
DETAILS: <2-3 sentences explaining the diagnosis and what should be done>

Be conservative. If confidence is low, recommend "notify_user" rather than taking action.`;
}

// ── Response parsing ─────────────────────────────────────────────────────────

function parseDiagnosisResponse(text: string, model: string, costUsd: number): DiagnosisResult {
  const rootCauseMatch = /ROOT CAUSE:\s*(.+)/i.exec(text);
  const confidenceMatch = /CONFIDENCE:\s*(low|medium|high)/i.exec(text);
  const actionMatch = /RECOMMENDED ACTION:\s*(\S+)/i.exec(text);

  let confidence = 0.5;
  if (confidenceMatch) {
    const level = confidenceMatch[1].toLowerCase();
    if (level === "high") confidence = 0.9;
    else if (level === "medium") confidence = 0.6;
    else if (level === "low") confidence = 0.3;
  }

  const actionRaw = actionMatch?.[1]?.toLowerCase() ?? "notify_user";
  const validActions = new Set(["restart", "revert_evolution", "revert_uncommitted", "notify_user", "none"]);
  const recommendedAction = validActions.has(actionRaw)
    ? (actionRaw as DiagnosisResult["recommendedAction"])
    : "notify_user";

  return {
    rootCause: rootCauseMatch?.[1]?.trim() ?? text.slice(0, 200),
    confidence,
    recommendedAction,
    model,
    costUsd,
  };
}

// ── Path 1: Claude Code CLI ($0 cost) ────────────────────────────────────────

async function diagnoseViaClaudeCode(
  prompt: string,
  cwd: string,
): Promise<{ text: string; model: string; costUsd: number }> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";

    // Strip ANTHROPIC_API_KEY so claude CLI uses subscription auth
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { ANTHROPIC_API_KEY: _strip, CLAUDECODE: _strip2, ...cleanEnv } = process.env;

    const proc = spawn(
      "claude",
      ["--dangerously-skip-permissions", "--print", prompt],
      { cwd, env: cleanEnv, shell: false },
    );

    const timeout = setTimeout(() => {
      proc.kill("SIGTERM");
      resolve({ text: stderr || "Diagnosis timed out after 60s", model: "claude-code", costUsd: 0 });
    }, 60_000);

    proc.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    proc.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- ChildProcess type lacks .on() in newer @types/node
    const p2 = proc as any;
    p2.on("close", () => {
      clearTimeout(timeout);
      resolve({ text: stdout || stderr, model: "claude-code", costUsd: 0 });
    });
    p2.on("error", () => {
      clearTimeout(timeout);
      resolve({ text: stderr || "Claude Code process error", model: "claude-code", costUsd: 0 });
    });
  });
}

// ── Path 2: Anthropic API fallback ──────────────────────────────────────────

async function diagnoseViaApi(
  prompt: string,
  dbPath: string,
): Promise<{ text: string; model: string; costUsd: number }> {
  // Read API key directly from SQLite
  let apiKey: string | undefined;
  try {
    const sqlite = new Database(dbPath, { readonly: true });
    sqlite.pragma("journal_mode = WAL");
    const row = sqlite.prepare("SELECT value FROM settings WHERE key = 'anthropic_key'").get() as { value: string } | undefined;
    sqlite.close();
    apiKey = row?.value || process.env.ANTHROPIC_API_KEY;
  } catch {
    apiKey = process.env.ANTHROPIC_API_KEY;
  }

  if (!apiKey) {
    return { text: "No API key available for diagnosis", model: "none", costUsd: 0 };
  }

  const model = "claude-haiku-4-5-20251001";

  try {
    // Dynamic import to avoid loading AI SDK in the supervisor unless needed
    const { generateText } = await import("ai");
    const { createAnthropic } = await import("@ai-sdk/anthropic");

    const anthropic = createAnthropic({ apiKey });
    const result = await generateText({
      model: anthropic(model),
      prompt,
      maxRetries: 1,
    });

    const tokensIn = result.usage?.inputTokens ?? 0;
    const tokensOut = result.usage?.outputTokens ?? 0;
    // Haiku pricing: $0.0008/1K input, $0.004/1K output
    const costUsd = (tokensIn * 0.0008 + tokensOut * 0.004) / 1000;

    return { text: result.text, model, costUsd };
  } catch (err) {
    return { text: `API diagnosis failed: ${err instanceof Error ? err.message : String(err)}`, model, costUsd: 0 };
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

export async function diagnoseProcessCrash(
  bundle: DiagnosticsBundle,
  projectRoot: string,
  dbPath: string,
): Promise<DiagnosisResult> {
  const prompt = buildDiagnosisPrompt(bundle);

  console.log(`[supervisor] Running AI diagnosis for ${bundle.processName}…`);

  // Prefer Claude Code ($0), fall back to API
  const claudeAvailable = await isClaudeCodeAvailable();
  const result = claudeAvailable
    ? await diagnoseViaClaudeCode(prompt, projectRoot)
    : await diagnoseViaApi(prompt, dbPath);

  console.log(`[supervisor] Diagnosis complete via ${result.model} (cost: $${result.costUsd.toFixed(4)})`);

  return parseDiagnosisResponse(result.text, result.model, result.costUsd);
}
