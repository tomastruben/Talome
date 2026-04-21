# Self-Improve — Apply a change to the Talome codebase

Use this skill when the user wants to modify Talome's own source code (bug fix, new feature, refactor, UI tweak).

## Pre-flight

1. **Read the target file(s)** before editing — understand existing patterns, naming, and style.
2. **Check Talome memories** — run `mcp__talome__recall` with a relevant query to see if the user has preferences that affect this change (e.g. "always use card components", "prefer minimal UI").
3. **Scope the change** — identify which app(s) are affected: `apps/core/`, `apps/dashboard/`, or both.
4. If the user provided **screenshots**, they are saved to `~/.talome/evolution-screenshots/` — read them before making UI changes.

## Workflow

1. **Plan** — describe what you will change, which files, and why. Keep it to one logical change.
2. **Edit** — make the changes using Edit/Write tools. Follow the conventions in CLAUDE.md:
   - TypeScript strict, named exports, kebab-case files
   - `HugeiconsIcon` only (no lucide-react)
   - shadcn/ui components only (never recreate)
   - Match existing patterns in the file
3. **Typecheck** — run the appropriate typecheck:
   ```bash
   # Backend changes
   pnpm exec tsc --noEmit -p apps/core/tsconfig.json
   # Frontend changes
   pnpm exec tsc --noEmit -p apps/dashboard/tsconfig.json
   ```
4. **Fix** — if typecheck fails, fix the errors and re-run. Do not move on until it passes.
5. **Verify** — if the Talome server is running, use MCP tools to verify:
   - `mcp__talome__list_containers` — check nothing crashed
   - `mcp__talome__get_container_logs` — look for runtime errors

## Rules

- **One change at a time** — never batch multiple unrelated changes
- **Only modify files within the project root** — no system files, no global installs
- **No eval()** — never, under any circumstances
- **If typecheck fails**, the change is not done — fix it first
- **Dark mode is the default** — all UI must look correct without light-mode override
