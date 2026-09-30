import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
vi.mock("../db/index.js", () => ({ db: {}, schema: {} }));
import { listGeneratedFiles } from "../creator/workspace-files.js";
import { assertNoPublicationConflicts, copyGeneratedArtifactSync, publicationValidationClaims } from "../stores/creator-artifacts.js";

describe("creator publication artifact boundary", () => {
  it("publishes exactly the file classes included by the workspace fingerprint", async () => {
    const root = mkdtempSync(join(tmpdir(), "talome-artifact-test-"));
    try {
      const source = join(root, "source");
      const destination = join(root, "published");
      mkdirSync(join(source, "app"), { recursive: true });
      writeFileSync(join(source, "app", "server.py"), "verified source");
      writeFileSync(join(source, "app", "creator.json"), "ordinary nested application file");
      writeFileSync(join(source, "creator.json"), "forged machine evidence must not publish");
      writeFileSync(join(source, "docker-compose.yml"), "services: {}");
      for (const directory of ["node_modules", ".git", ".next", ".venv", "__pycache__"]) {
        mkdirSync(join(source, directory));
        writeFileSync(join(source, directory, "untracked-output"), "must not publish");
      }
      copyGeneratedArtifactSync(source, destination);
      expect(await listGeneratedFiles(destination)).toEqual(await listGeneratedFiles(source));
      for (const file of await listGeneratedFiles(source)) {
        expect(readFileSync(join(destination, file))).toEqual(readFileSync(join(source, file)));
      }
      expect(() => readFileSync(join(destination, ".next", "untracked-output"))).toThrow();
      expect(() => readFileSync(join(destination, "creator.json"))).toThrow();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("rejects symlinks instead of silently publishing unfingerprinted target bytes", async () => {
    const root = mkdtempSync(join(tmpdir(), "talome-symlink-test-"));
    try {
      const source = join(root, "source");
      mkdirSync(source);
      writeFileSync(join(root, "outside.py"), "not part of generated source");
      symlinkSync(join(root, "outside.py"), join(source, "server.py"));
      await expect(listGeneratedFiles(source)).rejects.toThrow(/symlink/);
      expect(() => copyGeneratedArtifactSync(source, join(root, "published"))).toThrow(/symlink/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("strips caller-authored machine claims unless an internal validated snapshot was supplied", () => {
    const forged = [{ id: "native-browser", label: "Browser passed", status: "passed" as const, evidencePath: "/fake/report.json" }];
    expect(publicationValidationClaims(forged, false)).toEqual([]);
    expect(publicationValidationClaims(forged, true)).toEqual(forged);
  });

  it("refuses stale destination files without deleting app-owned data or replacing existing source", () => {
    const root = mkdtempSync(join(tmpdir(), "talome-publish-conflict-"));
    try {
      const source = join(root, "source");
      const destination = join(root, "installed");
      mkdirSync(source);
      mkdirSync(destination);
      writeFileSync(join(source, "server.py"), "new version");
      writeFileSync(join(destination, "server.py"), "current version");
      writeFileSync(join(destination, "user-data.sqlite"), "preserve user data");
      expect(() => assertNoPublicationConflicts(source, destination)).toThrow("user-data.sqlite");
      expect(readFileSync(join(destination, "server.py"), "utf8")).toBe("current version");
      expect(readFileSync(join(destination, "user-data.sqlite"), "utf8")).toBe("preserve user data");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("allows known source replacement and publisher metadata", () => {
    const root = mkdtempSync(join(tmpdir(), "talome-publish-update-"));
    try {
      const source = join(root, "source");
      const destination = join(root, "installed");
      mkdirSync(source);
      mkdirSync(destination);
      writeFileSync(join(source, "server.py"), "new version");
      for (const name of ["server.py", "manifest.json", "creator.json", "talome-app.json", "docker-compose.yml"]) writeFileSync(join(destination, name), "current");
      expect(() => assertNoPublicationConflicts(source, destination)).not.toThrow();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
