import { Hono } from "hono";
import { exec, execFile } from "node:child_process";
import { promisify } from "node:util";
import { serverError } from "../middleware/request-logger.js";
import { isValidSmartDevice } from "../ai/tools/storage-tools.js";

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

export const storage = new Hono();

/**
 * A drive's SMART verdict. "unknown" means the drive did not report one
 * (no SMART support, USB bridges that hide it, permission denied, smartctl
 * failed): that is not the same as failing, and the UI must not say it is.
 */
export type SmartHealth = "healthy" | "failing" | "unknown";

export interface SmartDriveReport {
  device: string;
  type: string;
  model: string;
  health: SmartHealth;
  /** Why the health is unknown, in plain words. Only set when health is "unknown". */
  reason?: string;
  temperature: number | null;
  powerOnHours: number | null;
}

/** Read the overall verdict from `smartctl --json -a` output. */
export function smartHealth(info: unknown): SmartHealth {
  if (!info || typeof info !== "object") return "unknown";
  const status = (info as { smart_status?: { passed?: unknown } }).smart_status;
  if (status && typeof status.passed === "boolean") return status.passed ? "healthy" : "failing";
  return "unknown";
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** One drive's report from parsed `smartctl --json -a` output (or null when it produced none). */
export function smartDriveReport(dev: { name: string; type?: string }, info: unknown): SmartDriveReport {
  const data = (info && typeof info === "object" ? info : {}) as {
    model_name?: unknown;
    model_family?: unknown;
    temperature?: { current?: unknown };
    power_on_time?: { hours?: unknown };
  };
  const health = smartHealth(info);
  const model = typeof data.model_name === "string" && data.model_name
    ? data.model_name
    : typeof data.model_family === "string" && data.model_family
      ? data.model_family
      : "Unknown";
  return {
    device: dev.name,
    type: dev.type ?? "unknown",
    model,
    health,
    ...(health === "unknown" ? { reason: "This drive doesn't report SMART health." } : {}),
    temperature: finiteOrNull(data.temperature?.current),
    powerOnHours: finiteOrNull(data.power_on_time?.hours),
  };
}

/**
 * Run smartctl and return its stdout. smartctl exits non-zero as a bitmask
 * even when it printed a full JSON report (bit 3 is "disk failing"), so a
 * non-zero exit with output is still a result, not an error.
 */
async function smartctlJson(args: string[]): Promise<unknown> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync("smartctl", args, { timeout: 10000 }));
  } catch (err) {
    const out = (err as { stdout?: unknown }).stdout;
    if (typeof out !== "string" || !out.trim()) throw err;
    stdout = out;
  }
  return JSON.parse(stdout);
}

/**
 * A scanned name smartctl can be queried with (one argv entry, never a
 * shell): a /dev path, or the IOService path smartctl reports for some
 * drives on macOS. Neither can be read as an option or climb out with "..".
 */
export function isQueryableScannedDevice(name: string): boolean {
  if (isValidSmartDevice(name)) return true;
  return /^IOService:\/[A-Za-z0-9_@,.:\/ ()-]+$/.test(name) && !name.split("/").includes("..");
}

/** A scan entry that can't be a drive at all (a flag, control characters) is not listed. */
function isPlausibleDeviceName(name: string): boolean {
  return name.length > 0 && name.length <= 512 && !name.startsWith("-") && !/[\0\r\n]/.test(name);
}

// SMART disk health
storage.get("/smart", async (c) => {
  let devices: { name: string; type: string; protocol: string }[];
  try {
    const data = (await smartctlJson(["--scan", "--json"])) as { devices?: unknown };
    devices = Array.isArray(data.devices)
      ? (data.devices as { name: string; type: string; protocol: string }[]).filter(
          (d) => d && typeof d.name === "string" && isPlausibleDeviceName(d.name),
        )
      : [];
  } catch {
    return c.json({ error: "smartctl not available" }, 503);
  }

  // Every scanned drive is reported: a drive whose details can't be read (or
  // whose name Talome won't hand to smartctl) is "unknown", never silently
  // dropped (and never "failing").
  const results = await Promise.all(
    devices.map(async (dev) => {
      if (!isQueryableScannedDevice(dev.name)) {
        return { ...smartDriveReport(dev, null), reason: "Talome can't query this drive by the name smartctl reported." };
      }
      try {
        return smartDriveReport(dev, await smartctlJson(["--json", "-a", dev.name]));
      } catch {
        return { ...smartDriveReport(dev, null), reason: "Talome couldn't read this drive's SMART data." };
      }
    }),
  );

  return c.json(results);
});

// Docker disk usage
storage.get("/docker-usage", async (c) => {
  try {
    const { stdout } = await execAsync("docker system df --format json", { timeout: 15000 });
    const lines = stdout.trim().split("\n").filter(Boolean);
    const usage = lines.map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
    return c.json(usage);
  } catch (err) {
    return serverError(c, err, { message: "Failed to get Docker disk usage" });
  }
});

// Storage breakdown by directory
storage.get("/breakdown", async (c) => {
  const dirs = [
    { path: "/var/lib/docker", label: "Docker data" },
    { path: `${process.env.HOME}/.talome`, label: "Talome data" },
    { path: "/tmp", label: "Temp files" },
  ];

  const results = await Promise.allSettled(
    dirs.map(async (dir) => {
      const { stdout } = await execAsync(`du -sb ${dir.path} 2>/dev/null || echo "0\t${dir.path}"`, { timeout: 10000 });
      const [sizeStr] = stdout.trim().split("\t");
      const bytes = parseInt(sizeStr, 10) || 0;
      return { ...dir, sizeBytes: bytes };
    }),
  );

  return c.json(
    results.map((r, i) =>
      r.status === "fulfilled"
        ? r.value
        : { ...dirs[i], sizeBytes: 0 },
    ),
  );
});

// GPU status
storage.get("/gpu", async (c) => {
  // Try NVIDIA
  try {
    const { stdout } = await execAsync(
      "nvidia-smi --query-gpu=name,driver_version,temperature.gpu,utilization.gpu,memory.used,memory.total --format=csv,noheader,nounits",
      { timeout: 5000 },
    );
    const gpus = stdout.trim().split("\n").map((line) => {
      const [name, driver, temp, util, memUsed, memTotal] = line.split(", ").map((s) => s.trim());
      return {
        vendor: "nvidia",
        name,
        driver,
        temperatureC: parseInt(temp, 10),
        utilizationPercent: parseInt(util, 10),
        vramUsedMB: parseInt(memUsed, 10),
        vramTotalMB: parseInt(memTotal, 10),
      };
    });
    return c.json(gpus);
  } catch {
    // Not available
  }

  // Try AMD
  try {
    const { stdout } = await execAsync("rocm-smi --showtemp --showuse --showmemuse --json", { timeout: 5000 });
    return c.json(JSON.parse(stdout));
  } catch {
    // Not available
  }

  return c.json([]);
});
