import type { BundledLanguage } from "shiki";

const EXT_TO_LANGUAGE: Record<string, BundledLanguage> = {
  // Programming languages
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "tsx",
  jsx: "jsx",
  py: "python",
  go: "go",
  rs: "rust",
  rb: "ruby",
  java: "java",
  kt: "kotlin",
  swift: "swift",
  c: "c",
  h: "c",
  cpp: "cpp",
  hpp: "cpp",
  cs: "csharp",
  php: "php",
  lua: "lua",
  r: "r",
  // Shell
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  fish: "fish",
  // Query / data
  sql: "sql",
  graphql: "graphql",
  gql: "graphql",
  // Config / markup
  json: "json",
  jsonc: "jsonc",
  yml: "yaml",
  yaml: "yaml",
  toml: "toml",
  xml: "xml",
  html: "html",
  htm: "html",
  css: "css",
  scss: "scss",
  less: "less",
  svg: "xml",
  // Docker / infra
  dockerfile: "dockerfile",
  tf: "hcl",
  hcl: "hcl",
  // Markdown / docs
  md: "markdown",
  mdx: "mdx",
  // Config files
  ini: "ini",
  conf: "ini",
  cfg: "ini",
  env: "ini",
  properties: "ini",
  // Misc
  makefile: "makefile",
  cmake: "cmake",
  diff: "diff",
  patch: "diff",
  nginx: "nginx",
};

/** Map a file extension (lowercase, no dot) to a Shiki BundledLanguage. */
export function getLanguageFromExtension(
  ext: string,
): BundledLanguage | null {
  return EXT_TO_LANGUAGE[ext] ?? null;
}

/** Returns true if Shiki can syntax-highlight this extension. */
export function isCodeHighlightable(ext: string): boolean {
  return ext in EXT_TO_LANGUAGE;
}
