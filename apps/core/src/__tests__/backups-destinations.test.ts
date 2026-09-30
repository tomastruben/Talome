import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { cpSync, mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { prepareBackupEnv } from "./helpers/backups-fixture.js";

interface ExecCall {
  file: string;
  args: string[];
  env: Record<string, string>;
  timeout?: number;
}
type ExecCb = (err: Error | null, stdout: string, stderr: string) => void;
const calls = vi.hoisted(() => [] as ExecCall[]);
const hooks = vi.hoisted(() => ({
  onCall: null as null | ((args: string[]) => void),
  /** Take over the call: return a fake child process and finish it later via cb */
  spawn: null as null | ((args: string[], cb: (err: Error | null, stdout: string, stderr: string) => void) => unknown),
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFile: vi.fn(
      (
        file: string,
        args: string[],
        opts: { env?: Record<string, string>; timeout?: number },
        cb: ExecCb,
      ) => {
        calls.push({ file, args, env: opts.env ?? {}, timeout: opts.timeout });
        hooks.onCall?.(args);
        if (hooks.spawn) return hooks.spawn(args, cb);
        cb(null, "", "");
        return undefined;
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
  hooks.onCall = null;
  hooks.spawn = null;
});

const STATS = ["--stats", "30s", "--stats-one-line", "--stats-log-level", "NOTICE"];

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
    let staged: string | null = null;
    hooks.onCall = (args) => {
      if (args[0] === "copy" && staged === null) staged = args[1];
    };
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
    // Uploads come from an encrypted staging copy, never the plaintext backup dir
    expect(calls[0].args).toEqual(["copy", staged, `${dest.managedRemoteName(d.id)}:my-bucket/talome/app1/2026-01-01`, ...STATS]);
    expect(staged).not.toBe(local);
    expect(existsSync(staged!)).toBe(false); // staging is cleaned up
  });

  it("encrypts off-site copies and decrypts them when fetched back", async () => {
    const created = dest.createDestination({ name: "Remote", type: "rclone", target: "b2:bucket/enc" });
    if (!created.ok) throw new Error(created.error);
    const d = dest.getDestination(created.destination.id)!;
    const local = join(env.root, "enc-src");
    mkdirSync(local, { recursive: true });
    const archive = Buffer.from("SECRET-DATA ".repeat(5000));
    writeFileSync(join(local, "data.tar.gz"), archive);
    writeFileSync(join(local, "manifest.json"), '{"appId":"secret-app"}');

    const remoteStore = join(env.root, "fake-remote");
    rmSync(remoteStore, { recursive: true, force: true });
    hooks.onCall = (args) => {
      if (args[0] !== "copy") return;
      if (args[1].startsWith("/")) cpSync(args[1], remoteStore, { recursive: true }); // upload
      else cpSync(remoteStore, args[2], { recursive: true }); // download
    };
    const copy = await dest.copyToDestination(d, local, "app", "b1");
    expect(copy.ok).toBe(true);
    expect(readdirSync(remoteStore).sort()).toEqual(["data.tar.gz.enc", "manifest.json.enc"]);
    for (const f of readdirSync(remoteStore)) {
      const content = readFileSync(join(remoteStore, f));
      expect(content.includes(Buffer.from("SECRET-DATA"))).toBe(false);
      expect(content.includes(Buffer.from("secret-app"))).toBe(false);
    }

    const fetched = join(env.root, "enc-fetched");
    const r = await dest.fetchFromDestination(d, "b2:bucket/enc/app/b1", fetched);
    expect(r.ok).toBe(true);
    expect(readdirSync(fetched).sort()).toEqual(["data.tar.gz", "manifest.json"]);
    expect(readFileSync(join(fetched, "data.tar.gz")).equals(archive)).toBe(true);
  });

  it("detects tampered encrypted copies", async () => {
    const { encryptFile, decryptFile } = await import("../backup/offsite-crypto.js");
    const src = join(env.root, "plain.bin");
    writeFileSync(src, "hello world");
    const enc = join(env.root, "plain.bin.enc");
    await encryptFile(src, enc);
    const buf = readFileSync(enc);
    buf[buf.length - 20] ^= 0xff;
    writeFileSync(enc, buf);
    await expect(decryptFile(enc, join(env.root, "plain.out"))).rejects.toThrow(/decrypt/);
    expect(existsSync(join(env.root, "plain.out"))).toBe(false);
  });

  it("rejects on-the-fly rclone remotes and connection strings (inline credentials)", () => {
    expect(dest.validateLegacyCloudTarget(":sftp,host=evil.example,user=x,pass=y:/loot").ok).toBe(false);
    expect(dest.validateLegacyCloudTarget(":s3:bucket").ok).toBe(false);
    expect(dest.validateLegacyCloudTarget("b2,account=abc,key=def:bucket").ok).toBe(false);
    expect(dest.validateLegacyCloudTarget("--config=/etc/passwd").ok).toBe(false);
    expect(dest.validateLegacyCloudTarget("relative/dir").ok).toBe(false);
    expect(dest.validateLegacyCloudTarget(join(env.root, "backups", "x")).ok).toBe(false);
    expect(dest.validateLegacyCloudTarget("b2:bucket/talome")).toEqual({ ok: true, target: "b2:bucket/talome" });
    expect(dest.validateLegacyCloudTarget("/mnt/nas/backups")).toEqual({ ok: true, target: "/mnt/nas/backups" });
    expect(dest.legacyCloudTargetDestination(":webdav,url=http://x:/y")).toBeNull();
    expect(dest.createDestinationSchema.safeParse({ name: "x", type: "rclone", target: ":s3,access_key_id=A:bucket" }).success).toBe(false);
  });

  it("refuses to delete a destination that backups or schedules still use", () => {
    const created = dest.createDestination({ name: "Used", type: "rclone", target: "b2:bucket/used" });
    if (!created.ok) throw new Error(created.error);
    const id = created.destination.id;
    db.run(sql`INSERT INTO backup_schedules (id, app_id, cron, retention_days, created_at, destination_id) VALUES ('s-used', NULL, '0 3 * * *', 30, ${new Date().toISOString()}, ${id})`);
    const r = dest.deleteDestination(id);
    expect(r.ok).toBe(false);
    db.run(sql`DELETE FROM backup_schedules WHERE id = 's-used'`);
    expect(dest.deleteDestination(id)).toEqual({ ok: true });
    expect(dest.deleteDestination(id)).toMatchObject({ ok: false, notFound: true });
  });

  it("uses an existing rclone remote as-is without credentials", async () => {
    const created = dest.createDestination({ name: "Existing", type: "rclone", target: "b2:bucket/path" });
    if (!created.ok) throw new Error(created.error);
    const d = dest.getDestination(created.destination.id)!;
    const src = join(env.root, "some-dir");
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, "data.tar.gz"), "x");
    await dest.copyToDestination(d, src, "app", "dir");
    expect(calls[0].args[0]).toBe("copy");
    expect(calls[0].args.slice(2)).toEqual(["b2:bucket/path/app/dir", ...STATS]);
    expect(Object.keys(calls[0].env).some((k) => k.startsWith("RCLONE_CONFIG_TALOME"))).toBe(false);
  });

  it("never kills a large upload or download on a fixed timer", async () => {
    const created = dest.createDestination({ name: "Slow uplink", type: "rclone", target: "b2:bucket/slow" });
    if (!created.ok) throw new Error(created.error);
    const d = dest.getDestination(created.destination.id)!;
    const src = join(env.root, "big-backup");
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, "data.tar.gz"), "x");
    await dest.copyToDestination(d, src, "app", "big");
    await dest.fetchFromDestination(d, "b2:bucket/slow/app/big", join(env.root, "big-fetched"));
    const transfers = calls.filter((c) => c.args[0] === "copy");
    expect(transfers).toHaveLength(2);
    // 0 = no execFile timeout (was 10 minutes)
    for (const c of transfers) expect(c.timeout).toBe(0);
    // short commands keep their timeouts
    await dest.testDestination(d);
    expect(calls.filter((c) => c.args[0] !== "copy").every((c) => (c.timeout ?? 0) > 0)).toBe(true);
  });

  it("aborts a transfer only when rclone stops making progress", async () => {
    const { rcloneSync, parseTransferred } = await import("../backup/rclone.js");
    const { EventEmitter } = await import("node:events");
    expect(parseTransferred("2026/01/01 03:00:00 NOTICE:    1.234 GiB / 5.000 GiB, 24%, 10.000 MiB/s, ETA 6m")).toBe("1.234GiB");
    expect(parseTransferred("2026/01/01 03:00:00 NOTICE:         0 B / 0 B, -, 0 B/s, ETA -")).toBe("0B");
    expect(parseTransferred("some other log line")).toBeNull();

    const child = Object.assign(new EventEmitter(), { stderr: new EventEmitter(), stdout: new EventEmitter(), killed: false, kill: vi.fn() });
    let finish!: (err: Error | null) => void;
    hooks.spawn = (_args, cb) => {
      finish = (err) => cb(err, "", "");
      child.kill.mockImplementation(() => {
        child.killed = true;
        finish(Object.assign(new Error("killed"), { signal: "SIGTERM" }));
        return true;
      });
      return child;
    };
    const pending = rcloneSync("/tmp/staging", "b2:bucket/x", { stallTimeoutMs: 120 });
    // steady progress for longer than the stall timeout
    for (let i = 1; i <= 6; i++) {
      await new Promise((r) => setTimeout(r, 50));
      child.stderr.emit("data", Buffer.from(`NOTICE:   ${i * 10} MiB / 1 GiB, ${i}%, 1 MiB/s, ETA 10m\n`));
    }
    expect(child.kill).not.toHaveBeenCalled();
    // same amount over and over: stalled
    for (let i = 0; i < 6; i++) {
      await new Promise((r) => setTimeout(r, 50));
      child.stderr.emit("data", Buffer.from("NOTICE:   60 MiB / 1 GiB, 6%, 0 B/s, ETA -\n"));
    }
    const r = await pending;
    expect(child.kill).toHaveBeenCalled();
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/no progress/);
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
