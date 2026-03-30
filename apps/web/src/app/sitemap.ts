import type { MetadataRoute } from "next";
import fs from "fs";
import path from "path";

function getDocSlugs(dir: string, prefix = ""): string[] {
  const slugs: string[] = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.isDirectory()) {
      slugs.push(...getDocSlugs(path.join(dir, entry.name), `${prefix}${entry.name}/`));
    } else if (entry.name.endsWith(".mdx")) {
      const name = entry.name === "index.mdx" ? "" : entry.name.replace(".mdx", "");
      const slug = `${prefix}${name}`.replace(/\/$/, "");
      if (slug) slugs.push(slug);
    }
  }

  return slugs;
}

export default function sitemap(): MetadataRoute.Sitemap {
  const baseUrl = "https://talome.dev";

  const staticPages: MetadataRoute.Sitemap = [
    {
      url: baseUrl,
      changeFrequency: "weekly",
      priority: 1.0,
    },
    {
      url: `${baseUrl}/docs`,
      changeFrequency: "weekly",
      priority: 0.9,
    },
  ];

  const docsDir = path.join(process.cwd(), "content/docs");
  let docPages: MetadataRoute.Sitemap = [];

  try {
    const slugs = getDocSlugs(docsDir);
    docPages = slugs.map((slug) => {
      const isGettingStarted = slug.startsWith("getting-started/");
      const isGuide = slug.startsWith("guides/");
      const isReference = slug.startsWith("reference/");

      let priority = 0.6;
      if (isGettingStarted) priority = 0.8;
      else if (isGuide) priority = 0.7;
      else if (isReference) priority = 0.7;

      return {
        url: `${baseUrl}/docs/${slug}`,
        changeFrequency: "monthly" as const,
        priority,
      };
    });
  } catch {
    // Content dir may not exist at build time
  }

  return [...staticPages, ...docPages];
}
