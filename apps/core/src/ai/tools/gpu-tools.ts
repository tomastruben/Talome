import { tool } from "ai";
import { z } from "zod";
import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

export const getGpuStatusTool = tool({
  description: "Get GPU status including utilization, temperature, VRAM usage, and driver version. Supports NVIDIA (nvidia-smi) and AMD (rocm-smi) GPUs.",
  inputSchema: z.object({}),
  execute: async () => {
    // Try NVIDIA first
    try {
      const { stdout } = await execAsync(
        "nvidia-smi --query-gpu=name,driver_version,temperature.gpu,utilization.gpu,memory.used,memory.total,power.draw,power.limit --format=csv,noheader,nounits",
        { timeout: 5000 },
      );

      const gpus = stdout.trim().split("\n").map((line) => {
        const [name, driver, temp, util, memUsed, memTotal, powerDraw, powerLimit] = line.split(", ").map((s) => s.trim());
        return {
          vendor: "nvidia" as const,
          name,
          driver,
          temperatureC: parseInt(temp, 10),
          utilizationPercent: parseInt(util, 10),
          vramUsedMB: parseInt(memUsed, 10),
          vramTotalMB: parseInt(memTotal, 10),
          vramPercent: Math.round((parseInt(memUsed, 10) / parseInt(memTotal, 10)) * 100),
          powerDrawW: parseFloat(powerDraw),
          powerLimitW: parseFloat(powerLimit),
        };
      });

      return { success: true, gpus };
    } catch {
      // NVIDIA not available, try AMD
    }

    // Try AMD ROCm
    try {
      const { stdout } = await execAsync("rocm-smi --showtemp --showuse --showmemuse --json", { timeout: 5000 });
      const data = JSON.parse(stdout);
      const gpus = Object.entries(data).filter(([k]) => k.startsWith("card")).map(([name, info]: [string, any]) => ({
        vendor: "amd" as const,
        name,
        temperatureC: parseFloat(info["Temperature (Sensor edge) (C)"] ?? "0"),
        utilizationPercent: parseFloat(info["GPU use (%)"] ?? "0"),
        vramUsedMB: Math.round(parseFloat(info["GPU memory use (%)"] ?? "0") * parseFloat(info["VRAM Total Memory (B)"] ?? "0") / 100 / 1048576),
        vramTotalMB: Math.round(parseFloat(info["VRAM Total Memory (B)"] ?? "0") / 1048576),
      }));

      return { success: true, gpus };
    } catch {
      // AMD not available
    }

    return {
      success: false,
      error: "No GPU detected. Neither nvidia-smi nor rocm-smi are available.",
      hint: "If you have a GPU, ensure the appropriate drivers are installed.",
    };
  },
});
