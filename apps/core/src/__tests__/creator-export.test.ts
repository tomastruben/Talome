import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const testHome = vi.hoisted(() => `${process.env.TMPDIR || "/tmp"}/talome-export-test-home`);

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    homedir: () => testHome,
  };
});

vi.mock("../db/index.js", () => ({
  db: {},
  schema: {},
}));

describe("exportAppAsBundle", () => {
  beforeEach(() => {
    mkdirSync(testHome, { recursive: true });
    const appDir = join(testHome, ".talome", "user-apps", "apps", "sample-app");
    mkdirSync(join(appDir, "generated-app", "app"), { recursive: true });

    writeFileSync(
      join(appDir, "manifest.json"),
      JSON.stringify({ id: "sample-app", name: "Sample App" }, null, 2),
    );
    writeFileSync(join(appDir, "docker-compose.yml"), "services:\n  web:\n    image: nginx:alpine\n");
    writeFileSync(
      join(appDir, "creator.json"),
      JSON.stringify(
        {
          workspace: {
            scaffoldPath: join(appDir, "generated-app"),
          },
        },
        null,
        2,
      ),
    );
    writeFileSync(
      join(appDir, "generated-app", "app", "page.tsx"),
      "export default function Page() { return <div>Hello</div>; }\n",
    );
  });

  it("includes creator metadata and scaffold files in the bundle", async () => {
    const { exportAppAsBundle } = await import("../stores/export.js");
    const result = exportAppAsBundle("sample-app");

    expect(result.success).toBe(true);
    expect(result.bundle?.app.creator).toBeDefined();
    expect(result.bundle?.app.workspaceFiles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "app/page.tsx",
        }),
      ]),
    );
  });
});
