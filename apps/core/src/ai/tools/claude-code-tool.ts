import { resolve } from "node:path";
import { db, schema } from "../../db/index.js";
import { desc } from "drizzle-orm";

export const PROJECT_ROOT = resolve(process.cwd(), "../..");

// ── Evolution log ─────────────────────────────────────────────────────────────

export interface EvolutionEntry {
  id: string;
  timestamp: string;
  task: string;
  scope: string;
  filesChanged: string[];
  typeErrors: string;
  rolledBack: boolean;
  duration: number;
}

type NewEvolutionEntry = Omit<EvolutionEntry, "id" | "timestamp">;

export async function logEvolution(entry: NewEvolutionEntry): Promise<void> {
  db.insert(schema.evolutionLog).values({
    id: `ev_${Date.now()}`,
    timestamp: new Date().toISOString(),
    task: entry.task,
    scope: entry.scope,
    filesChanged: JSON.stringify(entry.filesChanged),
    typeErrors: entry.typeErrors,
    rolledBack: entry.rolledBack,
    duration: entry.duration,
  }).run();
}

export async function readEvolutionLog(limit = 50): Promise<EvolutionEntry[]> {
  const rows = db
    .select()
    .from(schema.evolutionLog)
    .orderBy(desc(schema.evolutionLog.timestamp))
    .limit(limit)
    .all();

  return rows.map((row) => ({
    id: row.id,
    timestamp: row.timestamp,
    task: row.task,
    scope: row.scope,
    filesChanged: (() => {
      try { return JSON.parse(row.filesChanged) as string[]; } catch { return []; }
    })(),
    typeErrors: row.typeErrors,
    rolledBack: row.rolledBack,
    duration: row.duration,
  }));
}
