import { and, eq, like, or } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import type { SourceInput, SourceReference } from "./contracts.js";

function extractFirstUrl(input: string): string | undefined {
  const match = input.match(/https?:\/\/[^\s)]+/i);
  return match?.[0];
}

function scoreCatalogRow(row: typeof schema.appCatalog.$inferSelect, term: string): number {
  const lower = term.toLowerCase();
  const name = row.name.toLowerCase();
  const appId = row.appId.toLowerCase();
  const desc = `${row.tagline} ${row.description}`.toLowerCase();

  let score = 0;
  if (name === lower || appId === lower) score += 100;
  if (name.includes(lower)) score += 40;
  if (appId.includes(lower)) score += 30;
  if (desc.includes(lower)) score += 15;
  if (row.source === "user-created") score -= 10;
  return score;
}

function toSourceReference(row: typeof schema.appCatalog.$inferSelect, kind: SourceReference["kind"]): SourceReference {
  return {
    kind,
    label: `${row.name} (${row.storeSourceId})`,
    appId: row.appId,
    storeId: row.storeSourceId,
    composePath: row.composePath,
    notes: row.tagline || row.description || undefined,
  };
}

function searchCatalog(term: string): SourceReference[] {
  if (!term.trim()) return [];

  const likeTerm = `%${term}%`;
  const rows = db
    .select()
    .from(schema.appCatalog)
    .where(
      or(
        like(schema.appCatalog.name, likeTerm),
        like(schema.appCatalog.appId, likeTerm),
        like(schema.appCatalog.tagline, likeTerm),
        like(schema.appCatalog.description, likeTerm),
      ),
    )
    .limit(25)
    .all();

  return rows
    .map((row) => ({ row, score: scoreCatalogRow(row, term) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map((item) => toSourceReference(item.row, "auto-match"));
}

export function discoverSources(description: string, source: SourceInput): SourceReference[] {
  const sources: SourceReference[] = [];

  if (source.kind === "public-repo") {
    sources.push({
      kind: "public-repo",
      label: source.repoUrl,
      repoUrl: source.repoUrl,
      ref: source.ref,
    });
    return sources;
  }

  if (source.kind === "existing-store-app") {
    if (source.appId) {
      const row = db
        .select()
        .from(schema.appCatalog)
        .where(
          source.storeId
            ? and(
                eq(schema.appCatalog.appId, source.appId),
                eq(schema.appCatalog.storeSourceId, source.storeId),
              )
            : eq(schema.appCatalog.appId, source.appId),
        )
        .get();
      if (row) {
        sources.push(toSourceReference(row, "existing-store-app"));
        return sources;
      }
    }

    if (source.query) {
      sources.push(...searchCatalog(source.query));
      return sources;
    }
  }

  const inlineUrl = extractFirstUrl(description);
  if (inlineUrl) {
    sources.push({
      kind: inlineUrl.includes("github.com") ? "public-repo" : "public-doc",
      label: inlineUrl,
      repoUrl: inlineUrl.includes("github.com") ? inlineUrl : undefined,
      notes: inlineUrl.includes("github.com") ? "Detected from description" : "Public reference detected from description",
    });
  }

  if (source.kind === "scratch") {
    return sources;
  }

  sources.push(...searchCatalog(description));
  return sources.slice(0, 4);
}

export function renderSourceContext(sources: SourceReference[]): string {
  if (sources.length === 0) {
    return "No strong reusable source was found. Generate a greenfield app, but keep the result realistic and reusable.";
  }

  return [
    "Use these source references as preferred building blocks before inventing new structure:",
    ...sources.map((source) => {
      const details = [
        `kind=${source.kind}`,
        source.appId ? `appId=${source.appId}` : null,
        source.storeId ? `storeId=${source.storeId}` : null,
        source.repoUrl ? `repo=${source.repoUrl}` : null,
        source.composePath ? `composePath=${source.composePath}` : null,
        source.notes ? `notes=${source.notes}` : null,
      ]
        .filter(Boolean)
        .join(", ");
      return `- ${source.label}: ${details}`;
    }),
  ].join("\n");
}
