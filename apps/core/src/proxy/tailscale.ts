import { docker } from "../docker/client.js";

const TS_CONTAINER_NAME = "talome-tailscale";
const TS_IMAGE = "tailscale/tailscale:v1.80.3";

interface TailscaleStatus {
  running: boolean;
  ip?: string;
  hostname?: string;
  magicDNS?: string;
  peers?: number;
  error?: string;
}

export async function ensureTailscaleRunning(authKey: string, hostname?: string): Promise<{ ok: boolean; error?: string }> {
  const tsHostname = hostname ?? "talome";

  try {
    const container = docker.getContainer(TS_CONTAINER_NAME);
    const info = await container.inspect();
    if (!info.State.Running) {
      await container.start();
    }
    return { ok: true };
  } catch {
    // Container doesn't exist — create it
  }

  try {
    try {
      const stream = await docker.pull(TS_IMAGE);
      await new Promise((resolve, reject) => {
        docker.modem.followProgress(stream, (err: Error | null) => err ? reject(err) : resolve(undefined));
      });
    } catch {
      // Image may already exist
    }

    const container = await docker.createContainer({
      name: TS_CONTAINER_NAME,
      Image: TS_IMAGE,
      Env: [
        `TS_AUTHKEY=${authKey}`,
        `TS_HOSTNAME=${tsHostname}`,
        "TS_STATE_DIR=/var/lib/tailscale",
        "TS_USERSPACE=false",
      ],
      HostConfig: {
        NetworkMode: "host",
        CapAdd: ["NET_ADMIN", "NET_RAW"],
        Binds: [
          "talome-tailscale-state:/var/lib/tailscale",
          "/dev/net/tun:/dev/net/tun",
        ],
        RestartPolicy: { Name: "unless-stopped" },
      },
      Labels: {
        "talome.managed": "true",
        "talome.role": "tailscale",
      },
    });

    await container.start();
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg };
  }
}

export async function getTailscaleStatus(): Promise<TailscaleStatus> {
  try {
    const container = docker.getContainer(TS_CONTAINER_NAME);
    const info = await container.inspect();
    if (!info.State.Running) {
      return { running: false };
    }

    // Run `tailscale status --json` inside the container
    const exec = await container.exec({
      Cmd: ["tailscale", "status", "--json"],
      AttachStdout: true,
      AttachStderr: true,
    });
    const stream = await exec.start({});
    const output = await new Promise<string>((resolve) => {
      const chunks: Buffer[] = [];
      stream.on("data", (chunk: Buffer) => chunks.push(chunk));
      stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    });

    // Parse demuxed docker output (strip 8-byte header per frame)
    const jsonStr = output.replace(/[\x00-\x1f]/g, "").trim();
    try {
      const status = JSON.parse(jsonStr.slice(jsonStr.indexOf("{")));
      return {
        running: true,
        ip: status.Self?.TailscaleIPs?.[0],
        hostname: status.Self?.HostName,
        magicDNS: status.MagicDNSSuffix,
        peers: status.Peer ? Object.keys(status.Peer).length : 0,
      };
    } catch {
      return { running: true };
    }
  } catch {
    return { running: false };
  }
}

export async function stopTailscale(): Promise<void> {
  try {
    const container = docker.getContainer(TS_CONTAINER_NAME);
    await container.stop();
  } catch {
    // Not running
  }
}
