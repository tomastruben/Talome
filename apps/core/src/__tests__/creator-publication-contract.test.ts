import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createDefaultAppSpec } from "../app-specs/schema.js";

vi.mock("../app-specs/service.js", () => ({ getStoredAppSpec: vi.fn(() => ({ revision: 4 })) }));
import { preparePublicationContract } from "../creator/publication-contract.js";

describe("publication native contract", () => {
  it("materializes the exact next revision before browser hashing and rejects identity drift", async () => {
    const root = await mkdtemp(join(tmpdir(), "talome-publication-contract-"));
    try {
      const spec = createDefaultAppSpec({ appId: "test", name: "Test", description: "Test native app." });
      await writeFile(join(root, "talome-app.json"), JSON.stringify(spec));
      const prepared = preparePublicationContract(root, "test");
      expect(prepared?.revision).toBe(5);
      expect(JSON.parse(await readFile(join(root, "talome-app.json"), "utf8"))).toEqual(prepared);
      expect(spec.revision).toBe(1);
      expect(() => preparePublicationContract(root, "another-app")).toThrow("AppSpec appId must be another-app");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
