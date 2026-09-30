import { describe, expect, it } from "vitest";
import { clipCommentary } from "@/hooks/use-live-voice";

describe("clipCommentary", () => {
  it("keeps short answers as they are, on one line", () => {
    expect(clipCommentary("Jellyfin is up.\n\nSonarr too.")).toBe("Jellyfin is up. Sonarr too.");
  });

  it("ends long answers on a sentence so the voice doesn't stop mid-thought", () => {
    const long = `${"Radarr has three updates waiting. ".repeat(60)}Trailing words`;
    const clipped = clipCommentary(long, 200);
    expect(clipped.length).toBeLessThanOrEqual(200);
    expect(clipped.endsWith(".")).toBe(true);
  });
});
