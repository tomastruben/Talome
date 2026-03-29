# ADR-004: MCP Server Auto-Sync

## Status
Accepted

## Context
Talome exposes tools both to its dashboard assistant (via Vercel AI SDK) and to Claude Code (via MCP). Keeping these in sync manually would be error-prone — every new tool would need to be registered in two places.

## Decision
The MCP server iterates over `allTools` (from `getAllRegisteredTools()`) and auto-registers each as an MCP tool. No manual MCP registration is needed when adding tools.

The MCP server runs as a stdio process launched by Claude Code (configured in `.mcp.json`). It connects to the same SQLite database and Docker socket as the main server, and works independently of the Talome web server.

## Key files
- `apps/core/src/routes/mcp.ts` — `createMcpServer()` factory
- `apps/core/src/mcp-stdio.ts` — stdio entry point
- `.mcp.json` — Claude Code MCP configuration

## Consequences
- Zero maintenance: add a tool to agent.ts, it appears in MCP automatically
- MCP always has the full tool set (not filtered by active domains)
- Each tool must handle missing configuration gracefully since MCP doesn't filter by domain
- The `.mcp.json` is committed to the repo — Claude Code picks it up automatically
