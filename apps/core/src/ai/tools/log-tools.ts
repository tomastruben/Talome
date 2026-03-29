/**
 * Advanced log tools — cross-container log search with regex and time filtering.
 */

import { tool } from "ai";
import { z } from "zod";
import { listContainers, getContainerLogs } from "../../docker/client.js";

// ── search_container_logs ────────────────────────────────────────────────────

export const searchContainerLogsTool = tool({
  description: `Search logs across one or all containers using a regex pattern with optional time filtering. Returns matching log lines grouped by container.

Use this to find errors, warnings, or specific events across your entire stack without checking each container individually.

After calling: Present matches grouped by container. Highlight error/warning patterns. Suggest follow-up actions based on what was found.`,
  inputSchema: z.object({
    pattern: z.string().describe("Regex pattern to search for (e.g. 'error|failed|exception', 'connection refused')"),
    containerId: z.string().optional().describe("Search a specific container. Omit to search all running containers."),
    tail: z.number().default(500).describe("Number of recent log lines to search per container"),
    caseSensitive: z.boolean().default(false).describe("Whether the pattern match is case-sensitive"),
  }),
  execute: async ({ pattern, containerId, tail, caseSensitive }) => {
    let regex: RegExp;
    try {
      regex = new RegExp(pattern, caseSensitive ? "" : "i");
    } catch (err: unknown) {
      return {
        success: false,
        error: `Invalid regex pattern: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    const containers = await listContainers();
    const targets = containerId
      ? containers.filter(
          (c) => c.id === containerId || c.name.toLowerCase().includes(containerId.toLowerCase())
        )
      : containers.filter((c) => c.status === "running");

    if (targets.length === 0) {
      return {
        success: false,
        error: containerId
          ? `No container found matching '${containerId}'.`
          : "No running containers found.",
      };
    }

    const results: Array<{
      container: string;
      containerId: string;
      matchCount: number;
      matches: string[];
    }> = [];

    let totalMatches = 0;

    for (const target of targets) {
      try {
        const logs = await getContainerLogs(target.id, tail);
        const lines = logs.split("\n");
        const matches: string[] = [];

        for (const line of lines) {
          if (regex.test(line)) {
            matches.push(line.trim());
            if (matches.length >= 50) break; // Cap per container
          }
        }

        if (matches.length > 0) {
          results.push({
            container: target.name,
            containerId: target.id,
            matchCount: matches.length,
            matches,
          });
          totalMatches += matches.length;
        }
      } catch {
        // Skip containers we can't read logs from
      }
    }

    return {
      success: true,
      pattern,
      containersSearched: targets.length,
      containersWithMatches: results.length,
      totalMatches,
      results: results.sort((a, b) => b.matchCount - a.matchCount),
      summary: totalMatches > 0
        ? `Found ${totalMatches} matches across ${results.length} container(s).`
        : `No matches for '${pattern}' in ${targets.length} container(s).`,
    };
  },
});
