# ADR-004: MCP Server Auto-Sync

## Status
Accepted, amended by current `activeTools` implementation

## Context
Talome exposes tools both to its dashboard assistant (via Vercel AI SDK) and to Claude Code (via MCP). Keeping these in sync manually would be error-prone — every new tool would need to be registered in two places.

## Decision
The MCP server imports `activeTools` from `apps/core/src/ai/agent.ts` and auto-registers each active tool as an MCP tool. No manual MCP registration is needed when adding tools; a domain becomes visible to MCP when its `settingsKeys` are active.

The MCP server runs as a stdio process launched by Claude Code (configured in `.mcp.json`). It connects to the same SQLite database and Docker socket as the main server, and works independently of the Talome web server.

## Key files
- `apps/core/src/routes/mcp.ts` — `createMcpServer()` factory
- `apps/core/src/mcp-stdio.ts` — stdio entry point
- `.mcp.json` — Claude Code MCP configuration

## Consequences
- Zero maintenance: add a tool to agent.ts, and it becomes eligible for MCP automatically
- MCP uses the active-domain tool set, matching dashboard configuration
- Integration tools should still handle missing configuration gracefully
- The `.mcp.json` is committed to the repo — Claude Code picks it up automatically
