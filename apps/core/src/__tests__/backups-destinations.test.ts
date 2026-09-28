import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { prepareBackupEnv } from "./helpers/backups-fixture.js";

interface ExecCall {
  file: string;
  args: string[];
  env: Record<string, string>;
}
const calls = vi.hoisted(() => [] as ExecCall[]);

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFile: vi.fn(
      (
        file: string,
        args: string[],
        opts: { env?: Record<string, string> },
        cb: (err: Error | null, stdout: string, stderr: string) => void,
      ) => {
        calls.push({ file, args, env: opts.env ?? {} });
        cb(null, "", "");
      },
    ),
    exec: vi.fn(() => {
      throw new Error("shell exec must not be used for rclone");
    }),
  };
});
vi.mock("../db/notifications.js", () => ({ writeNotification: vi.fn() }));

const env = prepareBackupEnv("backups-destinations");
const { runMigrations } = await import("../db/migrate.js");
runMigrations();
const dest = await import("../backup/destinations.js");
const { db } = await import("../db/index.js");
const { sql } = await import("drizzle-orm");

afterAll(() => env.cleanup());
beforeEach(() => {
  calls.length = 0;
});

const SECRET = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
const ACCESS = "AKIAIOSFODNN7EXAMPLE";

describe("backup destinations", () => {
  it("stores credentials encrypted and never passes them on the rclone command line", async () => {
    const created = dest.createDestination({
      name: "B2 offsite",
      type: "rclone",
      target: "my-bucket/talome",
      remoteType: "s3",
      credentials: { provider: "AWS", access_key_id: ACCESS, secret_access_key: SECRET, region: "eu-west-1" },
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.destination.hasCredentials).toBe(true);

    // Encrypted at rest
    const raw = db.get(sql`SELECT value FROM settings WHERE key = ${`backup_destination_${created.destination.id}_secret`}`) as { value: string };
    expect(raw.value).not.toContain(SECRET);
    expect(raw.value).not.toContain(ACCESS);

    // Public listing never exposes credentials
    expect(JSON.stringify(dest.listDestinations())).not.toContain(SECRET);

    const local = join(env.root, "backup-dir");
    mkdirSync(local, { recursive: true });
    writeFileSync(join(local, "manifest.json"), "{}");
    const d = dest.getDestination(created.destination.id)!;

    const copy = await dest.copyToDestination(d, local, "app1", "2026-01-01");
    expect(copy.ok).toBe(true);
    await dest.testDestination(d);
    await dest.deleteFromDestination(d, "x:app1/2026-01-01");

    expect(calls.length).toBeGreaterThanOrEqual(3);
    const remote = dest.managedRemoteName(d.id).toUpperCase();
    for (const call of calls) {
      expect(call.file).toBe("rclone");
      const argv = call.args.join(" ");
      expect(argv).not.toContain(SECRET);
      expect(argv).not.toContain(ACCESS);
      expect(call.env[`RCLONE_CONFIG_${remote}_SECRET_ACCESS_KEY`]).toBe(SECRET);
      expect(call.env[`RCLONE_CONFIG_${remote}_ACCESS_KEY_ID`]).toBe(ACCESS);
      expect(call.env[`RCLONE_CONFIG_${remote}_TYPE`]).toBe("s3");
    }
    expect(calls[0].args).toEqual(["copy", local, `${dest.managedRemoteName(d.id)}:my-bucket/talome/app1/2026-01-01`, "--stats-one-line"]);
  });

  it("uses an existing rclone remote as-is without credentials", async () => {
    const created = dest.createDestination({ name: "Existing", type: "rclone", target: "b2:bucket/path" });
    if (!created.ok) throw new Error(created.error);
    const d = dest.getDestination(created.destination.id)!;
    await dest.copyToDestination(d, "/tmp/some-dir", "app", "dir");
    expect(calls[0].args).toEqual(["copy", "/tmp/some-dir", "b2:bucket/path/app/dir", "--stats-one-line"]);
    expect(Object.keys(calls[0].env).some((k) => k.startsWith("RCLONE_CONFIG_TALOME"))).toBe(false);
  });

  it("copies to local destinations and validates the target", async () => {
    const target = join(env.root, "external-disk");
    const created = dest.createDestination({ name: "USB", type: "local", target });
    if (!created.ok) throw new Error(created.error);
    const src = join(env.root, "src-backup");
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, "data.tar.gz"), "archive");
    const r = await dest.copyToDestination(dest.getDestination(created.destination.id)!, src, "app", "b1");
    expect(r.ok).toBe(true);
    expect(readFileSync(join(target, "app", "b1", "data.tar.gz"), "utf-8")).toBe("archive");
    const del = await dest.deleteFromDestination(dest.getDestination(created.destination.id)!, join(target, "app", "b1"));
    expect(del.ok).toBe(true);
    expect(existsSync(join(target, "app", "b1"))).toBe(false);
    // refuses paths outside the destination
    const outside = await dest.deleteFromDestination(dest.getDestination(created.destination.id)!, env.root);
    expect(outside.ok).toBe(false);
  });

  it("rejects invalid destination input", () => {
    expect(dest.createDestinationSchema.safeParse({ name: "x", type: "local", target: "relative/path" }).success).toBe(false);
    expect(dest.createDestinationSchema.safeParse({ name: "x", type: "rclone", target: "--config=/etc/passwd" }).success).toBe(false);
    expect(dest.createDestinationSchema.safeParse({ name: "x", type: "rclone", target: "bucket" }).success).toBe(false);
    expect(
      dest.createDestinationSchema.safeParse({ name: "x", type: "rclone", target: "bucket", remoteType: "s3", credentials: { "bad key": "v" } }).success,
    ).toBe(false);
    const inside = dest.createDestination({ name: "x", type: "local", target: join(env.root, "backups", "nested") });
    expect(inside.ok).toBe(false);
  });
});
