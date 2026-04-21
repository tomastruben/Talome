# Create App — Scaffold a new Talome app

Use this skill when generating files in a Talome app workspace (`~/.talome/generated-apps/<appId>/`).

## Before writing any code

1. **Read the blueprint** — `cat .talome-creator/blueprint.json` — this is the structured app spec.
2. **Read all instructions** — read every file in `.talome-creator/instructions/`. These are markdown guides tailored to this app.
3. **Read references** — `.talome-creator/references/` contains Talome source snapshots. Mirror their patterns.
4. **Check sources** — `.talome-creator/sources/` has existing app-store sources to adapt. Reuse before reinventing.

## Source reuse priority

1. Existing sources in `.talome-creator/sources/` (adapt, don't rewrite)
2. Public repo/template listed in the blueprint
3. Public compose examples from image docs
4. Generate from scratch only as last resort

## Docker conventions

- Stable, official images — never `:latest`
- Relative volume paths: `./data`, `./config` — never absolute host paths
- Always `restart: unless-stopped`
- Include healthchecks when the image supports them
- Default env: `PUID=1000`, `PGID=1000`, `TZ=America/New_York`
- Expose main web UI port cleanly

## UI conventions

- Use components from `apps/dashboard/src/components/ui/` — adapt, don't rebuild
- `HugeiconsIcon` exclusively for icons
- Tailwind CSS 4 utilities matching Talome's spacing/colour scales
- Same page structure, card patterns, and header patterns as existing Talome pages
- Generated UI must look like it belongs next to existing Talome screens

## Manifest quality

Fill all fields — no placeholders:

```json
{
  "id": "lowercase-hyphenated",
  "name": "Human Readable Name",
  "description": "One clear sentence.",
  "tagline": "Short phrase.",
  "version": "1.0.0",
  "icon": "relevant-emoji",
  "category": "media|productivity|developer|networking|storage|security|ai|other",
  "author": "Author Name"
}
```

## Output

Write all scaffold files to `generated-app/`. Generate real working code — no TODO placeholders.
