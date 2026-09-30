import { describe, expect, it } from "vitest";
import { speakableText } from "@/hooks/use-speech-output";

describe("speakableText", () => {
  it("reads markdown the way a person would say it", () => {
    const markdown = [
      "## Updates",
      "- **Jellyfin** has an update ([notes](https://example.com))",
      "1. Run `update_app`",
      "```bash",
      "docker compose pull",
      "```",
      "| app | version |",
      "Done.",
    ].join("\n");

    expect(speakableText(markdown)).toBe("Updates Jellyfin has an update (notes) Run update_app (code omitted) Done.");
  });

  it("returns nothing for empty replies", () => {
    expect(speakableText("   \n ")).toBe("");
  });
});
