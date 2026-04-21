import { tool } from "ai";
import { z } from "zod";
import { readdir, readFile } from "fs/promises";
import { join, relative } from "path";

const DOCS_DIR = join(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "..",
  "web",
  "content",
  "docs"
);

interface DocEntry {
  title: string;
  description: string;
  slug: string;
  content: string;
}

async function getAllDocs(dir: string = DOCS_DIR): Promise<DocEntry[]> {
  const entries: DocEntry[] = [];

  let items: string[];
  try {
    items = await readdir(dir, { recursive: true }) as unknown as string[];
  } catch {
    return entries;
  }

  for (const item of items) {
    if (!String(item).endsWith(".mdx")) continue;

    const fullPath = join(dir, String(item));
    try {
      const raw = await readFile(fullPath, "utf-8");

      // Parse frontmatter
      const fmMatch = raw.match(/^---\n([\s\S]*?)\n---/);
      let title = "";
      let description = "";
      if (fmMatch) {
        const fm = fmMatch[1];
        const titleMatch = fm.match(/^title:\s*(.+)$/m);
        const descMatch = fm.match(/^description:\s*(.+)$/m);
        if (titleMatch) title = titleMatch[1].replace(/^["']|["']$/g, "");
        if (descMatch) description = descMatch[1].replace(/^["']|["']$/g, "");
      }

      // Build slug from path
      const relPath = relative(dir, fullPath)
        .replace(/\.mdx$/, "")
        .replace(/\/index$/, "");
      const slug = relPath || "index";

      // Strip frontmatter and MDX components for content matching
      const content = raw
        .replace(/^---\n[\s\S]*?\n---\n*/, "")
        .replace(/<[A-Z]\w+[^>]*\/>/g, "")
        .replace(/<[A-Z]\w+[^>]*>[\s\S]*?<\/[A-Z]\w+>/g, "");

      entries.push({ title, description, slug, content });
    } catch {
      // Skip unreadable files
    }
  }

  return entries;
}

function scoreMatch(doc: DocEntry, query: string): number {
  const q = query.toLowerCase();
  const words = q.split(/\s+/).filter(Boolean);
  let score = 0;

  // Title match is most valuable
  const titleLower = doc.title.toLowerCase();
  if (titleLower.includes(q)) score += 100;
  for (const w of words) {
    if (titleLower.includes(w)) score += 20;
  }

  // Description match
  const descLower = doc.description.toLowerCase();
  if (descLower.includes(q)) score += 50;
  for (const w of words) {
    if (descLower.includes(w)) score += 10;
  }

  // Content match
  const contentLower = doc.content.toLowerCase();
  for (const w of words) {
    const count = (contentLower.match(new RegExp(w, "g")) || []).length;
    score += Math.min(count, 10) * 2;
  }

  // Slug match
  const slugLower = doc.slug.toLowerCase();
  for (const w of words) {
    if (slugLower.includes(w)) score += 15;
  }

  return score;
}

function extractExcerpt(content: string, query: string, maxLen = 300): string {
  const q = query.toLowerCase();
  const words = q.split(/\s+/).filter(Boolean);
  const lines = content.split("\n").filter((l) => l.trim());

  // Find the first line containing a query word
  for (const line of lines) {
    const lower = line.toLowerCase();
    if (words.some((w) => lower.includes(w))) {
      return line.slice(0, maxLen).trim();
    }
  }

  // Fallback to first non-heading lines
  const body = lines
    .filter((l) => !l.startsWith("#") && !l.startsWith("|"))
    .slice(0, 3)
    .join(" ");
  return body.slice(0, maxLen).trim();
}

export const queryDocsTool = tool({
  description:
    "Search the Talome documentation for information. Use this when a user asks about how Talome works, how to configure something, or needs help with a feature.",
  inputSchema: z.object({
    query: z.string().describe("Search query — what the user wants to know about"),
    section: z
      .string()
      .optional()
      .describe(
        "Optional section filter: getting-started, guides, integrations, reference, developers"
      ),
    limit: z
      .number()
      .default(3)
      .describe("Maximum number of results to return"),
  }),
  execute: async ({ query, section, limit }) => {
    let docs = await getAllDocs();

    // Filter by section if specified
    if (section) {
      docs = docs.filter((d) => d.slug.startsWith(section));
    }

    // Score and rank
    const scored = docs
      .map((doc) => ({ doc, score: scoreMatch(doc, query) }))
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    if (scored.length === 0) {
      return {
        results: [],
        message: `No documentation found for "${query}".`,
      };
    }

    return {
      results: scored.map((r) => ({
        title: r.doc.title,
        slug: r.doc.slug,
        description: r.doc.description,
        url: `/docs/${r.doc.slug}`,
        excerpt: extractExcerpt(r.doc.content, query),
        score: r.score,
      })),
    };
  },
});
