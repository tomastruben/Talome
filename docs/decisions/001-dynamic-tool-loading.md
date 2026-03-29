# ADR-001: Dynamic Tool Loading via Domain Registry

## Status
Accepted

## Context
Talome's AI assistant can integrate with many apps (Sonarr, Radarr, Jellyfin, Pi-hole, etc.), each with 4-27 tools. Loading all ~100+ tools into every dashboard chat session hurts LLM tool selection accuracy — the model struggles to pick the right tool from a large flat list.

## Decision
Tools are organized into **domains** — groups scoped to a specific app. Each domain declares `settingsKeys` that indicate whether the app is configured. The dashboard chat only loads tools for active domains. The MCP server (Claude Code) always loads everything.

## Key files
- `apps/core/src/ai/tool-registry.ts` — the registry engine
- `apps/core/src/ai/agent.ts` — domain registrations

## Consequences
- Dashboard chat sees ~40 core tools + only relevant domain tools (better LLM accuracy)
- MCP server sees all tools (Claude Code needs full access for codebase work)
- Adding a new app integration = one `registerDomain()` call, auto-synced to MCP
- Tools must handle missing configuration gracefully (return error, don't throw)
