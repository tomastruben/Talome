import { describe, expect, it } from "vitest";
import {
  AiCloudIcon,
  CompassIcon,
  Film01Icon,
  Package01Icon,
  Wallet01Icon,
} from "@/components/icons";
import {
  resolveApplicationIcon,
  resolveApplicationIconUrl,
} from "@/components/native-app/native-app-icons";

describe("application icon resolver", () => {
  it("converts legacy emoji metadata to Hugeicons", () => {
    expect(resolveApplicationIcon("🎬", "Jellyfin")).toBe(Film01Icon);
    expect(resolveApplicationIcon("⛈️", "Server Weather Guard")).toBe(AiCloudIcon);
    expect(resolveApplicationIcon("💰", "Budget Companion")).toBe(Wallet01Icon);
    expect(resolveApplicationIcon("🧭", "Strategy Intelligence")).toBe(CompassIcon);
  });

  it("uses a deterministic Hugeicon for unknown built apps", () => {
    expect(resolveApplicationIcon("🧪", "Custom Lab")).toBe(Package01Icon);
  });

  it("rejects emoji and local-file values from image URL metadata", () => {
    expect(resolveApplicationIconUrl("🧭")).toBeUndefined();
    expect(resolveApplicationIconUrl("file:///tmp/icon.png")).toBeUndefined();
    expect(resolveApplicationIconUrl("/api/icons/custom-app")).toBe("/api/icons/custom-app");
    expect(resolveApplicationIconUrl("https://example.com/icon.png")).toBe("https://example.com/icon.png");
  });
});
