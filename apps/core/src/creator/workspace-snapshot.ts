import { constants } from "node:fs";
import { chmod, mkdir, mkdtemp, open, realpath, stat, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { listGeneratedFiles } from "./workspace-files.js";
import type { TalomeAppSpec } from "@talome/types";

export async function snapshotNativeContract(spec: TalomeAppSpec): Promise<string> {
  const snapshotsRoot = join(homedir(), ".talome", "creator-validation");
  await mkdir(snapshotsRoot, { recursive: true, mode: 0o700 });
  const root = await mkdtemp(join(snapshotsRoot, "native-"));
  const scaffoldPath = join(root, "generated-app");
  await mkdir(scaffoldPath, { mode: 0o700 });
  await writeFile(join(scaffoldPath, "talome-app.json"), JSON.stringify(spec, null, 2), { mode: 0o600 });
  return scaffoldPath;
}

/** Private source copy validated and published as one artifact; the editable creator workspace is never copied after validation. */
export async function snapshotGeneratedWorkspace(sourceRoot: string, snapshotsRoot = join(homedir(), ".talome", "creator-validation")): Promise<string> {
  await mkdir(snapshotsRoot, { recursive: true, mode: 0o700 });
  const root = await mkdtemp(join(snapshotsRoot, "run-"));
  const scaffoldPath = join(root, "generated-app");
  await mkdir(scaffoldPath, { mode: 0o700 });
  const files = await listGeneratedFiles(sourceRoot);
  for (const file of files) {
    const destination = join(scaffoldPath, file);
    await mkdir(dirname(destination), { recursive: true });
    // Reject a leaf replaced with a symlink after enumeration. The copied bytes,
    // rather than a later reread of sourceRoot, become the validation input.
    const handle = await open(join(sourceRoot, file), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const metadata = await handle.stat();
      if (!metadata.isFile()) throw new Error(`Generated artifact is not a regular file: ${file}`);
      await writeFile(destination, await handle.readFile(), { flag: "wx", mode: metadata.mode & 0o777 });
      await chmod(destination, metadata.mode & 0o777);
    } finally { await handle.close(); }
  }
  // Compiler dependencies are not published artifacts. Reuse the installed
  // dependency directory for checks without copying it or installing anything.
  for (const file of files.filter((path) => path === "package.json" || path.endsWith("/package.json"))) {
    const packageDirectory = dirname(file);
    const dependencies = join(sourceRoot, packageDirectory, "node_modules");
    try {
      if ((await stat(dependencies)).isDirectory()) await symlink(await realpath(dependencies), join(scaffoldPath, packageDirectory, "node_modules"), "dir");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return scaffoldPath;
}
