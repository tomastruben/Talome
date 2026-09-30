import { describe, expect, it } from "vitest";
import { checkCreatorCliReadiness } from "../creator/cli-readiness.js";

describe("creator scaffold readiness", () => {
  it("accepts active subscription auth", async () => {
    expect(await checkCreatorCliReadiness(async () => ({ stdout: '{"loggedIn":true,"authMethod":"claude.ai"}' }))).toEqual({ ready: true });
  });
  it("does not imply files were generated when CLI auth is missing", async () => {
    expect(await checkCreatorCliReadiness(async () => ({ stdout: '{"loggedIn":false,"authMethod":"none"}' })))
      .toMatchObject({ ready: false, error: expect.stringContaining("blueprint remains available") });
  });
  it("recognizes negative JSON from exit 1, while refusing positive JSON from a failed command", async () => {
    const negative = await checkCreatorCliReadiness(async () => { throw { code: 1, stdout: '{"loggedIn":false,"authMethod":"none"}' }; });
    expect(negative).toMatchObject({ ready: false, error: expect.stringContaining("subscription login is not active") });
    expect(await checkCreatorCliReadiness(async () => { throw { code: 1, stdout: '{"loggedIn":true,"authMethod":"claude.ai"}' }; })).toMatchObject({ ready: false });
  });
  it("does not substitute API billing for subscription auth", async () => {
    expect(await checkCreatorCliReadiness(async () => ({ stdout: '{"loggedIn":true,"authMethod":"api_key"}' }))).toMatchObject({ ready: false });
  });
  it("fails clearly for missing, timed-out, or malformed CLI probes without exposing their output", async () => {
    for (const probe of [async () => { throw new Error("private stderr"); }, async () => ({ stdout: "private invalid output" })]) {
      const result = await checkCreatorCliReadiness(probe);
      expect(result).toMatchObject({ ready: false });
      expect(JSON.stringify(result)).not.toContain("private");
    }
  });
});
