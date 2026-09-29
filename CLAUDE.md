# Talome — Claude Code Context

Read this file before making any changes. It describes what Talome is, how the codebase is structured, what design and coding rules apply, and what to do in each context (self-improvement, app creation, interactive sessions).

---

## What is Talome

Talome is an AI-first, open-source home server management platform. It combines a Docker container orchestrator, a multi-source app store (Talome-native, CasaOS, Umbrel, user-created), and an agentic AI assistant — all in a single self-hosted package.

Users install, configure, and manage self-hosted apps through a chat interface. The AI can read system state, install apps, wire stacks together, create new apps, and improve its own codebase.

---

## Monorepo Structure

```
apps/core/          — Hono backend: AI agent, tools, Docker API, DB, MCP server
apps/dashboard/     — Next.js 16 frontend: dashboard, chat UI, app store
packages/types/     — Shared TypeScript types
```

Key backend paths:
- `apps/core/src/ai/agent.ts` — system prompt + domain registrations
- `apps/core/src/ai/tool-registry.ts` — dynamic tool loading engine
- `apps/core/src/ai/tools/` — all agent tool definitions
- `apps/core/src/routes/` — Hono API routes
- `apps/core/src/db/` — Drizzle ORM + SQLite schema
- `apps/core/src/creator/` — app creation orchestrator

Key frontend paths:
- `apps/dashboard/src/app/dashboard/` — Next.js App Router pages
- `apps/dashboard/src/components/ui/` — shadcn/ui primitives (always reuse)
- `apps/dashboard/src/components/widgets/` — dashboard widget components
- `apps/dashboard/src/components/assistant/` — AI chat components

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | Next.js 16 App Router, React 19, Tailwind CSS 4 |
| UI components | shadcn/ui (all primitives are already installed) |
| Backend | Hono (TypeScript), Vercel AI SDK |
| Database | SQLite via Drizzle ORM + better-sqlite3 |
| AI | Anthropic Claude via `@ai-sdk/anthropic` |
| Monorepo | pnpm workspaces + Turborepo |
| Runtime validation | Zod everywhere |

---

## Coding Conventions

- **TypeScript strict mode everywhere** — all changes must typecheck cleanly with `pnpm exec tsc --noEmit`
- **Named exports only** — no default exports except Next.js page components
- **File naming** — kebab-case files, PascalCase components, camelCase functions
- **No eval()** — never, under any circumstances
- **Zod for all schemas** — API routes, tool input schemas, structured outputs
- **Error handling** — use Result types where possible, never throw in library code
- **No alternative icon libraries** — see Icons section below
- **No alternative UI component libraries** — only shadcn/ui and Talome's own components
- Match the style of the file you are editing — don't introduce new patterns if existing ones work

---

## Design Principles

These principles apply to all UI work — generated apps, dashboard changes, new components:

- **Radical reduction** — if it doesn't serve the user's task, remove it
- **Breathing space** — `p-6` minimum on content areas, `gap-6` between cards
- **Honest materials** — no decorative gradients, no fake shadows, no visual noise
- **One primary action per view** — never compete for attention; secondary actions are secondary
- **Motion restraint** — all animations under 200ms, ease-out only, no bounce, no spring overshoot
- **Typography discipline** — use only `text-sm`, `text-base`, `text-lg`, `text-2xl`; weight `400` or `500` only
- **Dark mode is the default** — all UI must look correct without a light-mode override

---

## Colour Palette (OKLCH, dark mode)

```css
--background:        oklch(0.145 0 0)     /* very dark */
--foreground:        oklch(0.985 0 0)     /* near white */
--card:              oklch(0.205 0 0)
--border:            oklch(1 0 0 / 10%)
--input:             oklch(1 0 0 / 15%)
--muted:             oklch(0.269 0 0)
--muted-foreground:  oklch(0.708 0 0)
--primary:           oklch(0.922 0 0)
--status-healthy:    oklch(0.723 0.191 149.58)   /* green */
--status-warning:    oklch(0.795 0.184 86.047)   /* amber */
--status-critical:   oklch(0.704 0.191 22.216)   /* red */
```

All theming lives in `apps/dashboard/src/app/globals.css`. Never use inline colour overrides or per-component style attributes.

---

## Spacing Scale

```
xs   0.25rem    sm   0.5rem    md   0.75rem
lg   1rem       xl   1.5rem    2xl  2rem     3xl  3rem
```

Always use Tailwind utility classes that map to these values. Avoid arbitrary values like `p-[13px]`.

---

## UI Components — Always Reuse

All of these are already installed in `apps/dashboard/src/components/ui/`. **Never recreate them.** Import and use directly.

**Primitives:**
`alert` · `avatar` · `badge` · `bento-gallery` · `breadcrumb` · `button` · `button-group` · `card` · `chart` · `collapsible` · `command` · `dialog` · `dropdown-menu` · `empty-state` · `hover-card` · `input` · `input-group` · `label` · `popover` · `progress` · `scroll-area` · `search-field` · `select` · `separator` · `sheet` · `sidebar` · `skeleton` · `sonner` · `spinner` · `switch` · `table` · `tabs` · `textarea` · `tooltip`

**Dashboard Widgets** (`apps/dashboard/src/components/widgets/`):
`active-downloads` · `activity` · `arr-status` · `cpu` · `declarative` · `digest` · `disk` · `divider` · `list` · `media-calendar` · `memory` · `network` · `quick-actions` · `services` · `stat-tile` · `storage-mounts` · `system-health` · `system-info` · `system-status`

When generating new UI for a generated app, start with these components and adapt — don't build from scratch.

---

## Icons

**Use `HugeiconsIcon` exclusively.** Never import from `lucide-react` directly (it exists only as a peer dep for shadcn internals).

```tsx
import { HugeiconsIcon } from "@/components/icons";
import { Home01Icon, Settings01Icon } from "@/components/icons";

// Usage:
<HugeiconsIcon icon={Home01Icon} size={20} />
```

The icon barrel is at `apps/dashboard/src/components/icons.tsx`. If an icon you need isn't re-exported there, add it from `@hugeicons/core-free-icons`.

---

## App Creation — How It Works

When Claude Code is involved in creating a new app (via `executeWorkspaceGeneration`), the workspace is set up at `~/.talome/generated-apps/<appId>/` with:

```
.talome-creator/
  blueprint.json         — structured app spec (read this first)
  instructions/          — markdown guides (read all of these)
  references/            — Talome source file snapshots (mirror these)
  sources/               — existing app-store sources to adapt
generated-app/           — write your scaffold output here
```

**Always read `.talome-creator/blueprint.json` and all files in `.talome-creator/instructions/` before writing a single file.**

### App Lifecycle

1. **Blueprint generation** — orchestrator calls Claude (via Vercel AI SDK `generateObject`) to produce a structured `AppBlueprint`
2. **Workspace scaffolding** — Claude Code runs in the workspace to generate files
3. **Publish to My Creations** — draft saved to `~/.talome/user-apps/`, available immediately
4. **Install and test** — user installs from "My Creations" in the app store
5. **Submit to Community** — "Submit to Community" button on the app detail page; runs automated checks then queues for review

### Docker Conventions

- Use stable, official images — never `latest` tag
- Relative volume paths only: `./data`, `./config`, `./postgres` — never absolute host paths
- Always include `restart: unless-stopped`
- Include healthchecks when the image supports them
- Default env vars: `PUID=1000`, `PGID=1000`, `TZ=America/New_York`
- Keep environment variables minimal and clearly named; separate secrets from non-secrets
- Use persistent volumes for stateful services
- Expose the main web UI port cleanly

### Source Reuse Priority

1. Check `.talome-creator/sources/` — existing store apps to adapt (Plex, Sonarr, Radarr, Jellyfin, qBittorrent, Prowlarr, Overseerr, Paperless-ngx, Immich, Ollama, Pi-hole, Vaultwarden)
2. Public repository/template listed in the blueprint
3. Public compose examples from image documentation
4. Generate from scratch only as last resort

When adapting a source: preserve working patterns, only change what the request requires.

### Manifest Quality

Apps may be submitted to the Talome community store. Fill all manifest fields properly — no placeholders:

```json
{
  "id": "lowercase-hyphenated",
  "name": "Human Readable Name",
  "description": "One clear sentence.",
  "tagline": "Short phrase.",
  "version": "1.0.0",
  "icon": "🐳",
  "category": "media|productivity|developer|networking|storage|security|ai|other",
  "author": "Author Name"
}
```

### Scaffold Structure

For full-app scaffolds, generate real working code — not TODO placeholders. Use:
- `apps/dashboard/src/components/ui/` components, adapted for the new app
- `HugeiconsIcon` for all icons
- Tailwind CSS 4 utility classes that match the spacing/colour scales above
- The same page structure, card patterns, and header patterns as existing Talome pages

The generated UI should look like it belongs next to existing Talome screens on first render.

---

## Self-Improvement — Rules

When making changes to the Talome codebase itself (via `apply_change` from the AI agent):

- **Only modify files within the project root** — no files outside, no global installs, no system changes
- **TypeScript must pass** — `pnpm exec tsc --noEmit` from the affected app directory must exit 0
- **Match existing patterns** — read the file before editing; follow its conventions, naming, and style
- **One change at a time** — never chain multiple `apply_change` calls without confirming each result
- **Safety net** — changes are automatically stashed and reverted if typecheck fails; stash can be inspected with `git stash show -p`
- **Scope hints** — when working on backend only, focus on `apps/core/`; frontend only, `apps/dashboard/`

If the user provides screenshots with a self-improvement request, the images are saved to `~/.talome/evolution-screenshots/` — study them carefully before making UI changes.

---

## How to Run Claude Code

### Interactive mode (preferred for iterative work)

In the Talome dashboard, navigate to the **Terminal** page and click **"Launch Claude Code"**. This runs:

```bash
tmux new-session -A -s talome-claude -c <projectRoot> "claude"
```

This attaches to an existing `talome-claude` tmux session if one is already running, or creates a new one. Interactive mode lets you ask questions, see tool calls in real time, and steer the session. Use it for exploratory changes, debugging, and follow-up iterations on generated apps.

### Headless mode (automated)

The AI agent uses `claude --dangerously-skip-permissions --print <task>` for automated operations:
- `apply_change` — self-improvement changes with typecheck + auto-rollback
- `executeWorkspaceGeneration` — app scaffolding in a generated-app workspace

CLAUDE.md is read automatically in both modes.

---

## Tool Architecture — Dynamic Domain Loading

Tools are organized into **domains** — groups of tools that belong to a specific app or capability. Each domain declares which settings keys indicate the app is configured.

**Key files:**
- `apps/core/src/ai/tool-registry.ts` — registry engine (`registerDomain`, `registerDomainWithOnDemandGroups`, `getActiveRegisteredTools`, `getAllRegisteredTools`)
- `apps/core/src/ai/agent.ts` — domain registrations (each `registerDomain()` call) and the system prompt
- `apps/core/src/ai/tool-discovery.ts` — per-conversation chat routing and the `discover_tools` tool
- `apps/core/src/ai/execution.ts` — `executeTool()`, the single execution path for every tool call

**Active vs registered:** a domain with `settingsKeys` is active only when one of those settings has a value (e.g. `arr` needs `sonarr_url`/`radarr_url`/…). Domains with no settings keys are always active. MCP and automations see every tool of every active domain.

**Base vs on-demand (dashboard chat only):**
- **Base domains** — active domains with no settings keys and not `onDemand` (the everyday `core` ops surface, `setup`, `verification`). Sent on every chat turn; their prefix stays prompt-cache friendly.
- **On-demand domains** — everything else: app domains (`arr`, `jellyfin`, …), `onDemand: true` domains (`mdns`), and the `core` groups split out by `CORE_ON_DEMAND_GROUPS` in `agent.ts` (`docker-admin`, `storage`, `monitoring`, `app-management`, `memory-admin`, `widgets`, `automations`, `notifications`, `files`, `self-improvement`, `app-creator`). A conversation gains a domain when a user message matches its keywords, one of its tools was already used, or the model calls **`discover_tools`** with a keyword or tool name. The set only grows within a conversation and is persisted per conversation (`conversation_tool_domains`).

Count domains and tools from the source (`grep -c "registerDomain" apps/core/src/ai/agent.ts`, the settings tool browser) rather than trusting a table here.

**Adding a new domain:** Create the tool file in `apps/core/src/ai/tools/`, import the tools in `agent.ts`, and add a `registerDomain()` call with the appropriate `settingsKeys`, tiers (`read` / `modify` / `destructive`) and — for chat routing — `keywords`/`summary`. The MCP server and `discover_tools` pick it up automatically.

### One execution path: `executeTool()`

Every tool call — dashboard chat (via `gateToolExecution`), MCP over HTTP and stdio, automation steps (`automation/engine.ts`) and agent-loop remediation (`agent-loop/remediation.ts`) — goes through `executeTool()` in `apps/core/src/ai/execution.ts`. It applies, in order: per-actor grants (MCP tokens), the security mode (`permissive` / `cautious` / `locked`), server-issued approvals, execution with error normalization, and an actor-aware, redacted audit entry. Never call a tool's `execute()` directly from new code.

- **Actors:** `user` (session user in chat), `mcp_token` (token id + name), `mcp_stdio` (local owner), `automation` (automation id + name), `agent_loop` (`remediation`). The tool runs inside the actor's context (`ai/actor-context.ts`), so app operations it starts are journaled under that actor in `app_operations.actor` (`ops/operations.ts` `currentActor()`); `runWithActor()` still works for explicit overrides.
- **Approvals:** in cautious mode a destructive call returns `approval_required` with an `approvalId` and `approveUrl` (`/dashboard/settings/approvals?id=…`), and a notification with that `link` is written. After the owner approves, the caller retries with the same arguments plus `approval_id`. Approvals are bound to actor + tool + argument hash and are single-use. The model never sets the legacy `confirmed` flag — the execution service sets it once the call is authorized.
- **Unattended runs:** automations and the agent loop never wait. A step that needs approval (or has `approvalPolicy: "require_approval"`) ends `blocked_approval`; the owner approves from the notification link, and the next run with the same arguments (e.g. "Run now") consumes it. Remediation escalates once and does not re-ask the model while the approval is pending.

---

## Talome MCP Server

Talome exposes its tools over MCP in two ways. Both build the tool list per actor and route every call through `executeTool()`.

- **Local stdio** (`apps/core/src/mcp-stdio.ts`, launched by `.mcp.json` via `apps/core/mcp-launch.sh`) — **no HTTP server, no token needed**. It connects to the same SQLite database and Docker socket as the main server, so it runs as the local owner (`mcp_stdio`): no per-token grants, but the security mode, approvals and audit still apply. It re-evaluates the configured domains and disabled tools every ~15s (emitting `tools/list_changed`), and **exits when its client disconnects** (stdin closed, EPIPE, transport closed, signals, or the parent process going away).
- **HTTP** (`POST /api/mcp`, `apps/core/src/routes/mcp.ts`) — requires a Bearer token created in Settings. Each token carries **grants** (max tier, domains, allowed/denied tools, apps); the tool list is evaluated per request for that token, and every call is re-checked against the grants.

It works whether or not the full Talome web server is running (stdio).

### No setup required

The `.mcp.json` is already committed. When you open Claude Code in this repo, the `talome` MCP server starts automatically. Verify it's connected with `/mcp` in Claude Code — you should see `talome` listed with a green status.

If tools aren't showing up, run this once to ensure dependencies are installed:
```bash
pnpm install
```

### Available MCP Tools

The MCP tool list is every tool of the currently active domains (the same settings-based filtering as chat, without chat's base/on-demand routing), minus tools disabled in Settings, minus — for HTTP tokens — tools outside the token's grants. Core tools (Docker, system, apps, filesystem, widgets, automations, memories, settings, notifications, self-improvement, app creation) are always available.

Destructive tools in cautious mode return `[approval_required]` with an approval link: ask the user to approve it in Talome (Settings -> Approvals), then call the tool again with the same arguments plus `approval_id`. Never invent approval ids.

Full tool listing with descriptions: **`docs/tools-reference.md`**

---

## Gotchas

Common error patterns specific to this codebase. Read before making changes to avoid known pitfalls.

1. **Buffer in Response** — Node.js 22's `Buffer` isn't assignable to `BodyInit`. Always wrap with `new Uint8Array(buffer)` when passing to `new Response()`.

2. **Encrypted settings** — API keys stored via the settings API are encrypted at rest. When reading them for use (e.g., passing to AI providers), always use `decryptSetting()` from `utils/crypto.ts`, not raw DB reads.

3. **Top-level DB queries** — ES modules execute imports before the importing module's body. Never query the database at module top-level — migrations haven't run yet. Use `setTimeout()` or lazy initialization.

4. **Secure cookies over HTTP** — Don't set `secure: true` on cookies based on `NODE_ENV=production`. Self-hosted instances run over HTTP on LAN. The `secure` flag silently drops cookies in browsers over HTTP.

5. **Turbo env passthrough** — Turbo filters environment variables by default. Add required env vars to `globalEnv` in `turbo.json` or they won't reach sub-processes (tests, builds).

6. **Next.js 16 proxy.ts** — Next.js 16 replaced `middleware.ts` with `proxy.ts`. Both cannot coexist — if both files exist, the build fails. API rewrites from `next.config.ts` don't work in standalone builds — use `NextResponse.rewrite()` in proxy.ts instead.

7. **pnpm deploy** — In pnpm 10, `pnpm deploy` requires `--legacy` flag unless `inject-workspace-packages=true` is set. Without it, Docker builds fail.

8. **Docker COPY || true** — Shell tricks like `COPY ... 2>/dev/null || true` don't work in Dockerfiles. The `COPY` instruction doesn't support shell redirects.

---

### When to use MCP tools

- Verifying your changes work against a live running instance (check container status, read logs)
- **Reading user memories** before generating UI or app configs — use `recall` to check for user preferences that affect the change
- Checking what apps are installed before modifying app-related code
- Reading live system state (CPU/disk/memory) when working on monitoring or widget code

### Connection resilience

The MCP stdio server is a **process launched at Claude Code startup that lives as long as that Claude Code session** — it is independent of the Talome web server and exits when Claude Code disconnects. Editing files in the repo does **not** restart or affect your MCP connection. If you see "Connection error" in your terminal, that is Claude's API connection (internet blip), not the Talome MCP. Wait for the auto-reconnect; your MCP tools will still be available once you're reconnected.

If the MCP server itself does go down (rare), restart with `/mcp` in Claude Code to reinitialize.

---

## Two Memory Systems

Talome has **two independent memory systems** that serve different purposes:

### Talome Memories (assistant ↔ user)

Stored in SQLite (`memories` table). The dashboard assistant's knowledge about the user — preferences, facts, corrections. Top 10 memories are injected into the system prompt each chat turn, ranked by recency + access frequency + confidence.

- **Tools:** `remember`, `recall`, `forget`, `update_memory`, `list_memories`
- **Types:** `preference`, `fact`, `context`, `correction`
- **Deduplication:** >80% bigram similarity against recent memories

### Claude Code Auto-Memory (codebase patterns)

Stored in `~/.claude/projects/<project>/memory/`. Claude Code's knowledge about this codebase — debugging patterns, architecture notes, recurring issues. Persists across Claude Code sessions.

### Memory Bridge

When working on **user-facing features** in Claude Code (UI changes, app scaffolds, widget configs), use Talome's `recall` MCP tool to check for user preferences before generating. This avoids the user repeating themselves:

```
# Before generating UI or app config:
mcp__talome__recall("ui preferences")
mcp__talome__recall("media setup")
```

When working on **codebase-level patterns** (debugging, architecture), use Claude Code's auto-memory instead.

---

## Claude Code Skills

Reusable workflows are defined in `.claude/skills/`:

- **`/self-improve`** — Apply a change to Talome's codebase with typecheck validation
- **`/create-app`** — Scaffold a new app in a generated workspace
- **`/add-domain`** — Register a new tool domain for an app integration

Each skill has a `SKILL.md` with step-by-step instructions. Use them for repeatable workflows instead of improvising from scratch.

---

## Security Constraints

- Never expose Docker socket directly to the frontend
- API keys live in `.env` — never commit them, never log them
- All API routes validate input with Zod
- CORS restricted to the dashboard origin
- Never run `eval()` or execute arbitrary user-provided strings as code
