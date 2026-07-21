import { describe, expect, it } from "vitest";
import { capsuleFromFragment } from "@/lib/stack-import-bridge";

describe("stack import bridge", () => {
  it("accepts capsules from private and unreachable Talome handoff URLs", () => {
    const capsule = "t2.private-network-recipe.abcdefghijkl";
    expect(capsuleFromFragment(`#${capsule}`)).toBe(capsule);
    expect(capsuleFromFragment(`#${encodeURIComponent(capsule)}`)).toBe(capsule);
  });

  it("continues to accept legacy t2 capsules without a fingerprint", () => {
    expect(capsuleFromFragment("#t2.legacy_recipe")).toBe("t2.legacy_recipe");
  });

  it("rejects recovery codes and malformed fragments at the public bridge", () => {
    expect(capsuleFromFragment("#t1.recovery-code")).toBeNull();
    expect(capsuleFromFragment("#t2.contains spaces")).toBeNull();
    expect(capsuleFromFragment("#%E0%A4%A")).toBeNull();
  });
});
