import { describe, expect, it } from "vitest";
import {
  extractAssistantEntityReferences,
  findAssistantEntityReference,
} from "@/lib/assistant-entity-references";

describe("assistant entity references", () => {
  it("keeps readable service labels while resolving container IDs", () => {
    const references = extractAssistantEntityReferences([{
      toolName: "list_containers",
      output: { containers: [{ id: "559a5c6ca5b2", name: "559a5c6ca5b2", displayName: "logflare" }] },
    }]);
    expect(findAssistantEntityReference("logflare", references)).toEqual({ kind: "container", id: "559a5c6ca5b2", label: "logflare" });
    expect(findAssistantEntityReference("559a5c6ca5b2", references)?.label).toBe("logflare");
  });
  it("routes automation labels to their automation detail instead of media lookup", () => {
    const references = extractAssistantEntityReferences([{
      toolName: "list_automations",
      output: [
        { id: "watchdog-1", name: "Media Hub space watchdog", enabled: true },
        { id: "watchdog-2", name: "Media services self-heal watchdog", enabled: true },
      ],
    }]);

    expect(findAssistantEntityReference("Media Hub space watchdog", references)).toEqual({
      kind: "automation",
      id: "watchdog-1",
      label: "Media Hub space watchdog",
      href: "/dashboard/automations?id=watchdog-1",
    });
  });

  it("extracts service, movie, TV, audiobook, and app references from their own tools", () => {
    const references = extractAssistantEntityReferences([
      {
        toolName: "list_containers",
        output: { containers: [{ name: "Jellyfin", status: "running" }] },
      },
      {
        toolName: "get_library",
        output: {
          movies: [{ title: "Send Help", year: 2026, tmdbId: 123 }],
          tv: [{ title: "Silo", year: 2023, tvdbId: 456 }],
        },
      },
      {
        toolName: "audiobookshelf_get_library_items",
        output: { items: [{ id: "book-1", title: "Tvůrčí akt" }] },
      },
      {
        toolName: "search_apps",
        output: [{ id: "home-assistant", storeId: "umbrel", name: "Home Assistant" }],
      },
    ]);

    expect(findAssistantEntityReference("Jellyfin", references)?.kind).toBe("container");
    expect(findAssistantEntityReference("Send Help", references)).toMatchObject({
      kind: "media",
      mediaType: "movie",
      year: 2026,
    });
    expect(findAssistantEntityReference("Silo", references)).toMatchObject({
      kind: "media",
      mediaType: "tv",
    });
    expect(findAssistantEntityReference("Tvurci akt", references)).toMatchObject({
      kind: "audiobook",
      href: "/dashboard/audiobooks/book-1",
    });
    expect(findAssistantEntityReference("Home Assistant", references)).toMatchObject({
      kind: "app",
      href: "/dashboard/apps/umbrel/home-assistant",
    });
  });

  it("does not infer entities from arbitrary names in unrelated tool output", () => {
    const references = extractAssistantEntityReferences([{
      toolName: "get_system_health",
      output: { name: "A Different Man", id: "not-media" },
    }]);

    expect(references).toEqual([]);
  });
});
