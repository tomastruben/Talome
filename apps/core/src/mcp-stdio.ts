#!/usr/bin/env node
/**
 * Talome MCP stdio server.
 *
 * Claude Code launches this as a subprocess via .mcp.json — no HTTP server,
 * no token, no env vars required. Communication happens over stdin/stdout.
 *
 * The DB path defaults to ~/.talome/talome.db (same as the main server).
 * Docker access uses the same socket as the main server (/var/run/docker.sock).
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer } from "./routes/mcp.js";

const server = createMcpServer();
const transport = new StdioServerTransport();

await server.connect(transport);
