/**
 * The video player is black in both themes. Its surfaces carry the dark
 * token scope (class "dark", like the terminal), so in a light window its
 * muted text, fills and outline buttons use the values tuned for black rather
 * than the light window's see-through remaps. Its menu labels follow the type
 * rules: sentence case, text-xs, no 11px uppercase micro-labels.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const player = readFileSync(join(__dirname, "..", "components/files/media-player.tsx"), "utf-8");

describe("media player surfaces", () => {
  it("puts every black root (loading, error, playback) in the dark token scope", () => {
    const blackRoots = [...player.matchAll(/(?:className=|")[^"\n]*\bbg-black\b(?!\/)[^"\n]*"/g)].map((m) => m[0]);
    expect(blackRoots).toHaveLength(3);
    for (const root of blackRoots) expect(root).toMatch(/"dark\s/);
  });

  it("labels its menus in sentence case at text-xs, without uppercase micro-labels", () => {
    expect(player).not.toMatch(/uppercase/);
    expect(player).not.toMatch(/text-\[\d+px\]/);
    for (const label of ["Quality", "Speed", "Subtitles", "Audio"]) {
      expect(player).toContain(`<DropdownMenuLabel className="text-xs font-medium text-muted-foreground">${label}</DropdownMenuLabel>`);
    }
  });
});
