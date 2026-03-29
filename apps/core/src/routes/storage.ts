import { Hono } from "hono";
import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

export const storage = new Hono();

// SMART disk health
storage.get("/smart", async (c) => {
  try {
    const { stdout } = await execAsync("smartctl --scan --json", { timeout: 10000 });
    const data = JSON.parse(stdout);
    const devices: { name: string; type: string; protocol: string }[] = data.devices ?? [];

    const results = await Promise.allSettled(
      devices.map(async (dev) => {
        const { stdout: detail } = await execAsync(`smartctl --json -a ${dev.name}`, { timeout: 10000 });
        const info = JSON.parse(detail);
        return {
          device: dev.name,
          type: dev.type,
          model: info.model_name ?? info.model_family ?? "Unknown",
          health: info.smart_status?.passed ? "healthy" : "failing",
          temperature: info.temperature?.current ?? null,
          powerOnHours: info.power_on_time?.hours ?? null,
        };
      }),
    );

    return c.json(
      results
        .filter((r): r is PromiseFulfilledResult<any> => r.status === "fulfilled")
        .map((r) => r.value),
    );
  } catch {
    return c.json({ error: "smartctl not available" }, 503);
  }
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
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
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
