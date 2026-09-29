import { describe, it, expect, vi, afterAll } from "vitest";
import { prepareBackupEnv } from "./helpers/backups-fixture.js";

// What the MCP stdio process waits for before exiting after its client went
// away (mcp-stdio.ts wires this into installStdioShutdown's pendingWork).

vi.mock("../db/notifications.js", () => ({ writeNotification: vi.fn() }));

const env = prepareBackupEnv("backups-stdio-drain");
const { runMigrations } = await import("../db/migrate.js");
runMigrations();
const { withAppOperation } = await import("../ops/operations.js");
const { acquireAppOperation } = await import("../backup/state.js");
const { inFlightAppWork } = await import("../mcp-stdio-pending.js");

afterAll(() => env.cleanup());

describe("MCP stdio in-flight work", () => {
  it("lists app operations this process is running until they finish", async () => {
    expect(inFlightAppWork()).toEqual([]);
    let finish!: () => void;
    const gate = new Promise<void>((r) => {
      finish = r;
    });
    const running = withAppOperation("drainapp", "restore", "mcp_stdio", async () => {
      await gate;
      return { success: true };
    });
    await vi.waitFor(() => expect(inFlightAppWork()).toEqual(["restore of drainapp"]));
    finish();
    await running;
    expect(inFlightAppWork()).toEqual([]);
  });

  it("includes backups and restores holding the backup lock", () => {
    const handle = acquireAppOperation("lockedapp", "backup", "b-1")!;
    try {
      expect(inFlightAppWork()).toEqual(["backup of lockedapp"]);
    } finally {
      handle.release();
    }
    expect(inFlightAppWork()).toEqual([]);
  });
});
