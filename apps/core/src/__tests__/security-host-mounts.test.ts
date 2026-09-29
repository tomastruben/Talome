/**
 * add_volume_mount and install_app `volumeMounts` took any host path at
 * modify tier, so a prompt-injected chat or automation could mount / or the
 * Docker socket into a container without an approval. Now:
 *  - host paths follow the protected-tree rules of the Umbrel planner
 *    (stores/host-folders.ts): system, credential and Talome folders are
 *    refused, also through a symlink;
 *  - the Docker socket, or a folder outside the configured media/data roots,
 *    makes the call destructive (approval in cautious mode);
 *  - the dashboard install route applies the same rules (risky mounts: admin only).
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";

vi.hoisted(() => {
  const dir = (process.env.TMPDIR || "/tmp").replace(/\/$/, "");
  process.env.DATABASE_PATH = `${dir}/talome-security-host-mounts-${process.pid}-${Date.now()}/talome.db`;
  process.env.TALOME_SECRET ||= "a".repeat(64);
});

vi.mock("../db/notifications.js", () => ({ writeNotification: vi.fn() }));
vi.mock("../docker/client.js", () => ({ listContainers: async () => [] }));

import { mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { runMigrations } from "../db/migrate.js";
import { setSetting } from "../utils/settings.js";
import { acceptsApprovalArg, executeTool, getEffectiveTier, localStdioActor } from "../ai/execution.js";
import { addVolumeMountTool } from "../ai/tools/compose-tools.js";
import { installAppTool } from "../ai/tools/app-tools.js";
import { apps } from "../routes/apps.js";
import { checkHostMount, hostMountsNeedApproval } from "../stores/host-mounts.js";
import { validateBindMountSource, validateHostFolder } from "../stores/host-folders.js";
import { validateHostFolder as umbrelValidateHostFolder } from "../stores/umbrel-v2.js";

const work = realpathSync(mkdtempSync(join(tmpdir(), "talome-g7-mounts-")));
const MEDIA = join(work, "media");
const ELSEWHERE = join(work, "elsewhere");
const APP = "mountapp";
const composeFile = join(work, "compose", "docker-compose.yml");

function composeText(): string {
  return readFileSync(composeFile, "utf-8");
}

beforeAll(() => {
  runMigrations();
  mkdirSync(join(MEDIA, "Movies"), { recursive: true });
  mkdirSync(ELSEWHERE, { recursive: true });
  mkdirSync(join(work, "compose"), { recursive: true });
  symlinkSync("/etc", join(MEDIA, "etc-link"));
});

beforeEach(() => {
  setSetting("security_mode", "cautious");
  setSetting("media_root", MEDIA);
  writeFileSync(composeFile, "services:\n  mountapp:\n    image: nginx:1.27\n", "utf-8");
  db.delete(schema.installedApps).where(eq(schema.installedApps.appId, APP)).run();
  db.insert(schema.installedApps)
    .values({ appId: APP, storeSourceId: "test", status: "running", overrideComposePath: composeFile })
    .run();
  db.delete(schema.approvals).run();
});

describe("host path rules", () => {
  it("refuses system, credential and Talome folders — also through a symlink", () => {
    for (const p of ["/", "/etc", "/root/.ssh", "/var/lib/docker/volumes", "/proc/1", `${homedir()}/.ssh`, join(homedir(), ".talome"), "relative/path", "/data/../etc"]) {
      expect(checkHostMount(APP, p).error, p).toBeTruthy();
    }
    expect(checkHostMount(APP, join(MEDIA, "etc-link")).error).toMatch(/resolves to/);
  });

  it("a crafted app id does not unlock the home folder", () => {
    expect(checkHostMount("../..", `${homedir()}/.ssh`).error).toBeTruthy();
    expect(checkHostMount("../..", join(homedir(), ".talome", "db")).error).toBeTruthy();
  });

  it("the app's own data folder and the configured media root need no approval", () => {
    expect(checkHostMount(APP, join(homedir(), ".talome", "app-data", APP, "config"))).toEqual({ needsApproval: false });
    expect(checkHostMount(APP, join(MEDIA, "Movies"))).toEqual({ needsApproval: false });
  });

  it("the Docker socket and folders outside the configured roots need approval", () => {
    expect(checkHostMount(APP, "/var/run/docker.sock")).toMatchObject({ needsApproval: true });
    expect(checkHostMount(APP, ELSEWHERE)).toMatchObject({ needsApproval: true });
    expect(checkHostMount(APP, "/srv/talome-g7-not-a-root")).toMatchObject({ needsApproval: true });
  });

  it("the Umbrel planner keeps its rules (shared helper)", () => {
    expect(umbrelValidateHostFolder).toBe(validateHostFolder);
    expect(validateHostFolder("/var/run/docker.sock")).toMatch(/cannot be mounted/);
    expect(validateBindMountSource("/var/run/docker.sock")).toBeNull();
    expect(validateHostFolder("/mnt/media/Photos")).toBeNull();
  });
});

describe("effective tier", () => {
  it("add_volume_mount: modify inside the roots, destructive for the socket or outside", () => {
    const args = (hostPath: string) => ({ appId: APP, hostPath, containerPath: "/data" });
    expect(getEffectiveTier("add_volume_mount", args(join(MEDIA, "Movies")), "modify")).toBe("modify");
    expect(getEffectiveTier("add_volume_mount", args("/var/run/docker.sock"), "modify")).toBe("destructive");
    expect(getEffectiveTier("add_volume_mount", args(ELSEWHERE), "modify")).toBe("destructive");
    expect(acceptsApprovalArg("add_volume_mount", "modify")).toBe(true);
  });

  it("install_app: volume mounts and Umbrel folder choices outside the roots are destructive", () => {
    expect(getEffectiveTier("install_app", { appId: "jellyfin", storeId: "s", volumeMounts: { media: MEDIA } }, "modify")).toBe("modify");
    expect(getEffectiveTier("install_app", { appId: "jellyfin", storeId: "s" }, "modify")).toBe("modify");
    expect(getEffectiveTier("install_app", { appId: "jellyfin", storeId: "s", volumeMounts: { media: "/var/run/docker.sock" } }, "modify")).toBe("destructive");
    expect(getEffectiveTier("install_app", { appId: "jellyfin", storeId: "s", volumeMounts: { media: ELSEWHERE } }, "modify")).toBe("destructive");
    expect(hostMountsNeedApproval("install_app", { appId: "x", umbrel: { folders: { photos: ELSEWHERE } } })).toBe(true);
    expect(hostMountsNeedApproval("install_app", { appId: "x", umbrel: { dataRoot: ELSEWHERE } })).toBe(true);
    expect(acceptsApprovalArg("install_app", "modify")).toBe(true);
  });
});

describe("through executeTool (cautious mode)", () => {
  const run = (hostPath: string) =>
    executeTool({
      actor: localStdioActor(),
      source: "mcp",
      toolName: "add_volume_mount",
      tool: addVolumeMountTool,
      baseTier: "modify",
      args: { appId: APP, hostPath, containerPath: "/data" },
    });

  it("mounting the Docker socket waits for the owner's approval", async () => {
    const r = await run("/var/run/docker.sock");
    expect(r.outcome).toBe("approval_required");
    expect(composeText()).not.toContain("docker.sock");
  });

  it("a folder outside the configured roots waits for approval", async () => {
    const r = await run(ELSEWHERE);
    expect(r.outcome).toBe("approval_required");
    expect(composeText()).not.toContain(ELSEWHERE);
  });

  it("a protected folder is refused outright", async () => {
    const r = await run("/");
    expect(r.outcome).not.toBe("success");
    expect(JSON.stringify(r)).toMatch(/protected/);
    expect(composeText()).not.toContain("- /:/data");
  });

  it("a media folder mounts without an approval", async () => {
    const r = await run(join(MEDIA, "Movies"));
    expect(r.outcome).toBe("success");
    expect(composeText()).toContain(`${join(MEDIA, "Movies")}:/data`);
  });

  it("install_app refuses a protected volume mount before installing", async () => {
    const r = await executeTool({
      actor: localStdioActor(),
      source: "mcp",
      toolName: "install_app",
      tool: installAppTool,
      baseTier: "modify",
      args: { appId: "jellyfin", storeId: "none", volumeMounts: { media: "/etc" } },
    });
    expect(r.outcome).not.toBe("success");
    expect(JSON.stringify(r)).toMatch(/protected system folder/);
  });
});

describe("dashboard install route", () => {
  function appAs(role: "admin" | "member") {
    const app = new Hono();
    app.use("*", async (c, next) => {
      c.set("sessionRole" as never, role as never);
      c.set("sessionUser" as never, `${role}-1` as never);
      await next();
    });
    app.route("/", apps);
    return app;
  }
  const install = (role: "admin" | "member", volumeMounts: Record<string, string>) =>
    appAs(role).request("/none/jellyfin/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ volumeMounts }),
    });

  it("refuses protected folders for everyone", async () => {
    const res = await install("admin", { media: "/etc" });
    expect(res.status).toBe(400);
  });

  it("only an admin may mount the Docker socket or a folder outside the roots", async () => {
    expect((await install("member", { media: "/var/run/docker.sock" })).status).toBe(403);
    expect((await install("member", { media: ELSEWHERE })).status).toBe(403);
    // An admin gets past the mount check (the app itself is not in any catalog here).
    expect((await install("admin", { media: ELSEWHERE })).status).not.toBe(403);
  });
});
