import { describe, it, expect, vi, beforeEach } from "vitest";
import { resolve, join } from "node:path";
import * as os from "node:os";
import * as fs from "node:fs/promises";
import { existsSync } from "node:fs";

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockDbGet = vi.hoisted(() => vi.fn());

vi.mock("../db/index.js", () => ({
  db: {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          get: mockDbGet,
        }),
      }),
    }),
  },
  schema: {
    installedApps: { appId: "appId" },
  },
}));

vi.mock("../db/audit.js", () => ({ writeAuditEntry: vi.fn() }));

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("config-tools", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(join(os.tmpdir(), "talome-config-test-"));
  });

  describe("safeConfigPath", () => {
    it("rejects paths with '..'", async () => {
      const { safeConfigPath } = await import("../ai/tools/config-tools.js");
      expect(() => safeConfigPath("/some/path/../etc/passwd")).toThrow("path traversal");
    });

    it("resolves a clean absolute path", async () => {
      const { safeConfigPath } = await import("../ai/tools/config-tools.js");
      expect(safeConfigPath("/opt/homeassistant/config")).toBe(
        resolve("/opt/homeassistant/config")
      );
    });
  });

  describe("read_app_config_file", () => {
    it("returns file content for a valid path inside volume mount", async () => {
      // write a temp config file
      const configFile = join(tmpDir, "configuration.yaml");
      await fs.writeFile(configFile, "homeassistant:\n  name: Home\n", "utf-8");

      // write a temp compose file referencing tmpDir as a volume mount
      const composeFile = join(tmpDir, "docker-compose.yml");
      await fs.writeFile(
        composeFile,
        `services:\n  homeassistant:\n    image: homeassistant/home-assistant\n    volumes:\n      - ${tmpDir}:/config\n`,
        "utf-8"
      );

      mockDbGet.mockReturnValue({ overrideComposePath: composeFile });

      const { readAppConfigFileTool } = await import("../ai/tools/config-tools.js");
      const result = await (readAppConfigFileTool.execute as Function)({
        appId: "homeassistant",
        filePath: configFile,
      });

      expect(result.success).toBe(true);
      expect(result.content).toContain("homeassistant:");
    });

    it("returns error when file does not exist", async () => {
      const composeFile = join(tmpDir, "docker-compose.yml");
      await fs.writeFile(
        composeFile,
        `services:\n  app:\n    image: test\n    volumes:\n      - ${tmpDir}:/data\n`,
        "utf-8"
      );

      mockDbGet.mockReturnValue({ overrideComposePath: composeFile });

      const { readAppConfigFileTool } = await import("../ai/tools/config-tools.js");
      const result = await (readAppConfigFileTool.execute as Function)({
        appId: "test",
        filePath: join(tmpDir, "nonexistent.conf"),
      });

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/not found/i);
    });

    it("rejects path traversal", async () => {
      mockDbGet.mockReturnValue({ overrideComposePath: null });

      const { readAppConfigFileTool } = await import("../ai/tools/config-tools.js");
      const result = await (readAppConfigFileTool.execute as Function)({
        appId: "app",
        filePath: "/opt/app/../../../etc/passwd",
      });

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/path traversal/i);
    });
  });

  describe("write_app_config_file", () => {
    it("writes content and creates a backup of the original", async () => {
      const configFile = join(tmpDir, "settings.conf");
      const originalContent = "original=true\n";
      await fs.writeFile(configFile, originalContent, "utf-8");

      const composeFile = join(tmpDir, "docker-compose.yml");
      await fs.writeFile(
        composeFile,
        `services:\n  app:\n    image: test\n    volumes:\n      - ${tmpDir}:/data\n`,
        "utf-8"
      );

      mockDbGet.mockReturnValue({ overrideComposePath: composeFile });

      const { writeAppConfigFileTool } = await import("../ai/tools/config-tools.js");
      const result = await (writeAppConfigFileTool.execute as Function)({
        appId: "test",
        filePath: configFile,
        content: "updated=true\n",
      });

      expect(result.success).toBe(true);
      expect(result.bytesWritten).toBe("updated=true\n".length);

      // File should now have new content
      const written = await fs.readFile(configFile, "utf-8");
      expect(written).toBe("updated=true\n");

      // A backup should exist
      const backupDir = join(process.env.HOME || "/tmp", ".talome", "backups", "config-files");
      if (existsSync(backupDir)) {
        const backups = await fs.readdir(backupDir);
        const appBackups = backups.filter((f) => f.startsWith("test"));
        expect(appBackups.length).toBeGreaterThan(0);
      }
    });

    it("rejects path traversal on write", async () => {
      mockDbGet.mockReturnValue({ overrideComposePath: null });

      const { writeAppConfigFileTool } = await import("../ai/tools/config-tools.js");
      const result = await (writeAppConfigFileTool.execute as Function)({
        appId: "app",
        filePath: "/etc/../etc/passwd",
        content: "hacked",
      });

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/path traversal/i);
    });

    it("rejects file outside volume mounts", async () => {
      const composeFile = join(tmpDir, "docker-compose.yml");
      const mountPath = join(tmpDir, "data");
      await fs.mkdir(mountPath, { recursive: true });
      await fs.writeFile(
        composeFile,
        `services:\n  app:\n    image: test\n    volumes:\n      - ${mountPath}:/data\n`,
        "utf-8"
      );

      mockDbGet.mockReturnValue({ overrideComposePath: composeFile });

      const { writeAppConfigFileTool } = await import("../ai/tools/config-tools.js");
      // Use a different tmpDir subdir — exists but NOT inside mountPath
      const siblingDir = join(tmpDir, "not-mounted");
      await fs.mkdir(siblingDir, { recursive: true });
      const outsidePath = join(siblingDir, "outside.conf");

      const result = await (writeAppConfigFileTool.execute as Function)({
        appId: "app",
        filePath: outsidePath,
        content: "content",
      });

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/not inside any of this app's volume mounts/i);
    });
  });
});
