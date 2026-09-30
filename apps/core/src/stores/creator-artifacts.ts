import { lstatSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { GENERATED_ARTIFACT_IGNORES } from "../creator/workspace-files.js";
import { atomicWriteFileSync } from "../utils/filesystem.js";
import type { ValidationCheck } from "../creator/contracts.js";

/** Publication must copy exactly the source classes included in the validator's fingerprint. */
export function copyGeneratedArtifactSync(source: string, destination: string, prefix = ""): void {
  if (lstatSync(source).isSymbolicLink()) throw new Error("Generated artifact root cannot be a symlink");
  mkdirSync(destination, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    if (GENERATED_ARTIFACT_IGNORES.has(entry.name)) continue;
    if (!prefix && entry.name === "creator.json") continue;
    if (entry.isSymbolicLink()) throw new Error(`Generated source symlinks cannot be published: ${entry.name}`);
    const sourcePath = join(source, entry.name);
    const destinationPath = join(destination, entry.name);
    if (entry.isDirectory()) copyGeneratedArtifactSync(sourcePath, destinationPath, join(prefix, entry.name));
    else if (entry.isFile()) atomicWriteFileSync(destinationPath, readFileSync(sourcePath));
    else throw new Error(`Unsupported generated artifact: ${entry.name}`);
  }
}

/** An update may replace known files, but must never silently retain or delete unknown app data. */
export function assertNoPublicationConflicts(source: string, destination: string): void {
  if (lstatSync(destination).isSymbolicLink()) throw new Error("Existing app directory is a symlink; review before publishing");
  const expected = new Set(["manifest.json", "creator.json", "talome-app.json"]);
  const enumerate = (root: string, prefix = ""): string[] => readdirSync(join(root, prefix), { withFileTypes: true }).flatMap((entry) => {
    if (GENERATED_ARTIFACT_IGNORES.has(entry.name)) return [];
    const path = prefix ? join(prefix, entry.name) : entry.name;
    if (entry.isSymbolicLink()) throw new Error(`Publication contains a symlink that needs review: ${path}`);
    return entry.isDirectory() ? enumerate(root, path) : [path];
  });
  const sourceFiles = enumerate(source);
  for (const path of sourceFiles) expected.add(path);
  // Seed-only drafts generate their Compose document from the blueprint.
  if (!sourceFiles.includes("docker-compose.yml") && !sourceFiles.includes("docker-compose.yaml")) expected.add("docker-compose.yml");
  const conflicts = enumerate(destination).filter((path) => !expected.has(path));
  if (conflicts.length) {
    throw new Error(`Publication would leave ${conflicts.length} existing file(s) outside the validated source: ${conflicts.slice(0, 5).join(", ")}. Existing app files and data were left unchanged; review these files before publishing.`);
  }
}

/** JSON clients may supply notes, but cannot attest that machine checks actually ran. */
export function publicationValidationClaims(checks: ValidationCheck[] | undefined, trustedSnapshot: boolean): ValidationCheck[] {
  return trustedSnapshot && Array.isArray(checks) ? checks : [];
}
