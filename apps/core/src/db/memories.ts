import { db, schema } from "./index.js";
import { eq, desc, sql, and } from "drizzle-orm";

type MemoryType = "preference" | "fact" | "context" | "correction";

// Simple character-level similarity ratio (Dice coefficient on bigrams).
// Returns 0–1; 1 = identical.
function similarity(a: string, b: string): number {
  const bigrams = (s: string) => {
    const set = new Map<string, number>();
    const lower = s.toLowerCase();
    for (let i = 0; i < lower.length - 1; i++) {
      const bg = lower.slice(i, i + 2);
      set.set(bg, (set.get(bg) ?? 0) + 1);
    }
    return set;
  };
  const aMap = bigrams(a);
  const bMap = bigrams(b);
  let intersection = 0;
  for (const [bg, count] of aMap) {
    const bCount = bMap.get(bg) ?? 0;
    intersection += Math.min(count, bCount);
  }
  const total = a.length - 1 + (b.length - 1);
  return total === 0 ? 1 : (2 * intersection) / total;
}

export async function writeMemory(
  type: MemoryType,
  content: string,
  source?: string,
  confidence = 1.0,
): Promise<void> {
  try {
    // Dedup: skip if >80% similar to any of the last 30 memories
    const recent = db
      .select({ content: schema.memories.content })
      .from(schema.memories)
      .orderBy(desc(schema.memories.createdAt))
      .limit(30)
      .all();

    for (const row of recent) {
      if (similarity(content, row.content) > 0.8) return;
    }

    const now = new Date().toISOString();
    db.insert(schema.memories)
      .values({ type, content, source, confidence, createdAt: now, updatedAt: now })
      .run();
  } catch (err) {
    console.error("[memories] writeMemory error:", err);
  }
}

export async function getTopMemories(n = 10): Promise<typeof schema.memories.$inferSelect[]> {
  try {
    // Rank by blend of recency, access frequency, and confidence.
    // Recency score: unix epoch normalised to 0–1 range over the last 30 days.
    const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const rows = db
      .select()
      .from(schema.memories)
      .where(and(eq(schema.memories.enabled, true)))
      .orderBy(
        sql`(
          0.4 * ((unixepoch(${schema.memories.createdAt}) * 1000 - ${thirtyDaysAgo}) / (${Date.now()} - ${thirtyDaysAgo}))
          + 0.3 * min(${schema.memories.accessCount} / 10.0, 1.0)
          + 0.3 * ${schema.memories.confidence}
        ) DESC`,
      )
      .limit(n)
      .all();

    if (rows.length > 0) {
      const ids = rows.map((r) => r.id);
      for (const id of ids) {
        db.update(schema.memories)
          .set({ accessCount: sql`access_count + 1` })
          .where(eq(schema.memories.id, id))
          .run();
      }
    }

    return rows;
  } catch (err) {
    console.error("[memories] getTopMemories error:", err);
    return [];
  }
}

export async function searchMemories(query: string): Promise<typeof schema.memories.$inferSelect[]> {
  try {
    // FTS5 full-text search via raw SQL (drizzle doesn't model virtual tables)
    const stmt = db.$client.prepare(
      `SELECT m.* FROM memories m
       JOIN memories_fts ON memories_fts.rowid = m.id
       WHERE memories_fts MATCH ? AND m.enabled = 1
       ORDER BY rank
       LIMIT 5`,
    );
    return stmt.all(query) as typeof schema.memories.$inferSelect[];
  } catch {
    // Fallback: LIKE search if FTS fails (e.g. special chars in query)
    return db
      .select()
      .from(schema.memories)
      .where(
        and(
          eq(schema.memories.enabled, true),
          sql`lower(${schema.memories.content}) LIKE lower(${"%" + query + "%"})`,
        ),
      )
      .limit(5)
      .all();
  }
}

export async function deleteMemory(id: number): Promise<void> {
  db.delete(schema.memories).where(eq(schema.memories.id, id)).run();
}

export async function clearAllMemories(): Promise<void> {
  db.delete(schema.memories).run();
}

export async function updateMemory(
  id: number,
  updates: { content?: string; type?: MemoryType; confidence?: number },
): Promise<boolean> {
  try {
    const existing = db
      .select()
      .from(schema.memories)
      .where(eq(schema.memories.id, id))
      .get();
    if (!existing) return false;

    const set: Record<string, unknown> = { updatedAt: new Date().toISOString() };
    if (updates.content !== undefined) set.content = updates.content;
    if (updates.type !== undefined) set.type = updates.type;
    if (updates.confidence !== undefined) set.confidence = updates.confidence;

    db.update(schema.memories).set(set).where(eq(schema.memories.id, id)).run();
    return true;
  } catch (err) {
    console.error("[memories] updateMemory error:", err);
    return false;
  }
}

export async function listAllMemories(
  opts: { type?: MemoryType; limit?: number } = {},
): Promise<typeof schema.memories.$inferSelect[]> {
  try {
    const { type, limit = 20 } = opts;
    if (type) {
      return db
        .select()
        .from(schema.memories)
        .where(and(eq(schema.memories.enabled, true), eq(schema.memories.type, type)))
        .orderBy(desc(schema.memories.createdAt))
        .limit(limit)
        .all();
    }
    return db
      .select()
      .from(schema.memories)
      .where(eq(schema.memories.enabled, true))
      .orderBy(desc(schema.memories.createdAt))
      .limit(limit)
      .all();
  } catch (err) {
    console.error("[memories] listAllMemories error:", err);
    return [];
  }
}
