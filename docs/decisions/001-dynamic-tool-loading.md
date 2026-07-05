# ADR-001: Dynamic Tool Loading via Domain Registry

## Status
Accepted

## Context
Talome's AI assistant can integrate with many apps (Sonarr, Radarr, Jellyfin, Pi-hole, etc.), each with 4-27 tools. Loading all ~100+ tools into every dashboard chat session hurts LLM tool selection accuracy — the model struggles to pick the right tool from a large flat list.

## Decision
Tools are organized into **domains** — groups scoped to a specific app. Each domain declares `settingsKeys` that indicate whether the app is configured. Dashboard chat and MCP both use the active-domain tool set; dashboard chat can further narrow tools with message keyword routing.

## Key files
- `apps/core/src/ai/tool-registry.ts` — the registry engine
- `apps/core/src/ai/agent.ts` — domain registrations

## Consequences
- Dashboard chat sees active or keyword-routed tools instead of the full registry
- MCP server uses `activeTools`, so external clients match the configured Talome setup
- Adding a new app integration = one `registerDomain()` call, eligible for MCP when active
- Integration tools should still handle missing configuration gracefully
