import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { rmSync } from "node:fs";

vi.hoisted(() => {
  process.env.DATABASE_PATH = `${process.env.TMPDIR ?? "/tmp"}/talome-smart-route-${process.pid}.db`;
  process.env.TALOME_SECRET ||= "a".repeat(64);
});

afterAll(() => {
  for (const suffix of ["", "-wal", "-shm"]) rmSync(`${process.env.DATABASE_PATH}${suffix}`, { force: true });
});

type Reply = { stdout?: string; error?: Error & { stdout?: string } };

/** What `smartctl <args>` answers, keyed by the device (or "scan"). */
const replies = vi.hoisted(() => new Map<string, Reply>());
const execFileCalls = vi.hoisted(() => [] as Array<{ file: string; args: string[] }>);

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  type Callback = (err: Error | null, result?: { stdout: string; stderr: string }) => void;
  const lastCallback = (rest: unknown[]): Callback => rest.filter((a) => typeof a === "function").pop() as Callback;
  return {
    ...actual,
    exec: vi.fn((_cmd: string, ...rest: unknown[]) => lastCallback(rest)(null, { stdout: "", stderr: "" })),
    execFile: vi.fn((file: string, args: string[], ...rest: unknown[]) => {
      execFileCalls.push({ file, args });
      const key = args.includes("--scan") ? "scan" : args[args.length - 1];
      const reply = replies.get(key) ?? { error: Object.assign(new Error("no reply"), { stdout: "" }) };
      if (reply.error) lastCallback(rest)(reply.error);
      else lastCallback(rest)(null, { stdout: reply.stdout ?? "", stderr: "" });
    }),
  };
});

const { storage, smartHealth } = await import("../routes/storage.js");

function scan(names: string[]) {
  replies.set("scan", {
    stdout: JSON.stringify({ devices: names.map((name) => ({ name, type: "sat", protocol: "ATA" })) }),
  });
}

async function getSmart() {
  const res = await storage.request("/smart");
  return { status: res.status, body: (await res.json()) as Array<Record<string, unknown>> };
}

beforeEach(() => {
  replies.clear();
  execFileCalls.length = 0;
});

describe("smartHealth", () => {
  it("is healthy or failing only when the drive reported a verdict", () => {
    expect(smartHealth({ smart_status: { passed: true } })).toBe("healthy");
    expect(smartHealth({ smart_status: { passed: false } })).toBe("failing");
  });

  it("is unknown when the drive has no SMART verdict (regression: used to be failing)", () => {
    expect(smartHealth({})).toBe("unknown");
    expect(smartHealth({ smart_status: {} })).toBe("unknown");
    expect(smartHealth(null)).toBe("unknown");
    expect(smartHealth({ smart_status: { passed: "yes" } })).toBe("unknown");
  });
});

describe("GET /smart", () => {
  it("reports a drive without SMART data as unknown with a reason, not failing", async () => {
    scan(["/dev/sda"]);
    replies.set("/dev/sda", { stdout: JSON.stringify({ model_name: "USB bridge" }) });
    const { status, body } = await getSmart();
    expect(status).toBe(200);
    expect(body).toEqual([
      expect.objectContaining({ device: "/dev/sda", model: "USB bridge", health: "unknown", reason: expect.any(String) }),
    ]);
  });

  it("keeps a failing drive whose smartctl exits non-zero with a full report", async () => {
    scan(["/dev/sdb"]);
    replies.set("/dev/sdb", {
      error: Object.assign(new Error("Command failed: exit 8"), {
        stdout: JSON.stringify({ model_name: "Old disk", smart_status: { passed: false }, temperature: { current: 51 } }),
      }),
    });
    const { body } = await getSmart();
    expect(body).toEqual([expect.objectContaining({ device: "/dev/sdb", health: "failing", temperature: 51 })]);
  });

  it("lists a drive it could not read as unknown instead of dropping it", async () => {
    scan(["/dev/sda", "/dev/nvme0n1"]);
    replies.set("/dev/sda", { stdout: JSON.stringify({ model_name: "Good", smart_status: { passed: true }, power_on_time: { hours: 1200 } }) });
    const { body } = await getSmart();
    expect(body.map((d) => [d.device, d.health])).toEqual([
      ["/dev/sda", "healthy"],
      ["/dev/nvme0n1", "unknown"],
    ]);
    expect(body[0].powerOnHours).toBe(1200);
    expect(body[1].reason).toMatch(/couldn't read/i);
  });

  it("never passes a scanned device name to smartctl that is not a /dev path", async () => {
    scan(["/dev/sda", "--scan-open", "/dev/../etc/shadow"]);
    replies.set("/dev/sda", { stdout: JSON.stringify({ smart_status: { passed: true } }) });
    const { body } = await getSmart();
    expect(body.map((d) => d.device)).toEqual(["/dev/sda"]);
    expect(execFileCalls.every((c) => c.file === "smartctl")).toBe(true);
    expect(execFileCalls.filter((c) => !c.args.includes("--scan")).map((c) => c.args.at(-1))).toEqual(["/dev/sda"]);
  });

  it("answers 503 when smartctl is missing", async () => {
    const { status } = await getSmart();
    expect(status).toBe(503);
  });
});
