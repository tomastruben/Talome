import { describe, expect, it } from "vitest";
import { configPatchSchema, patchComposeConfig } from "../stores/config-patch.js";

describe("app configuration changes", () => {
  it("preserves equals signs and inherited environment entries when editing list syntax", () => {
    const original = { services: { app: { environment: ["TOKEN=a=b==", "INHERITED", "EDIT=before"] } } };
    const result = patchComposeConfig(original, { serviceName: "app", env: { EDIT: "after" } });
    expect(result).toEqual({ services: { app: { environment: { TOKEN: "a=b==", INHERITED: null, EDIT: "after" } } } });
    expect(original.services.app.environment).toEqual(["TOKEN=a=b==", "INHERITED", "EDIT=before"]);
  });

  it("changes only the selected service and port mapping, preserving addresses, protocols and metadata", () => {
    const original = { services: {
      other: { ports: ["5000:80"] },
      app: { ports: ["127.0.0.1:8080:80/tcp", "[::1]:8080:80/udp", { target: 90, published: 9090, host_ip: "127.0.0.1", protocol: "tcp", mode: "host" }] },
    } };
    expect(patchComposeConfig(original, { serviceName: "app", portMappings: [{ index: 1, published: 8081 }, { index: 2, published: 9091 }] })).toEqual({ services: {
      other: { ports: ["5000:80"] },
      app: { ports: ["127.0.0.1:8080:80/tcp", "[::1]:8081:80/udp", { target: 90, published: "9091", host_ip: "127.0.0.1", protocol: "tcp", mode: "host" }] },
    } });
  });

  it("supports legacy target mappings and automatically published ports", () => {
    expect(patchComposeConfig({ services: { app: { ports: [80, "127.0.0.1:5000:53/udp"] } } }, { serviceName: "app", ports: { "80": 8080, "53/udp": 5353 } })).toEqual({ services: { app: { ports: ["8080:80", "127.0.0.1:5353:53/udp"] } } });
  });

  it.each([0, 65536, 80.5, "8080", null])("rejects invalid host port %s before writing", (published) => {
    expect(configPatchSchema.safeParse({ serviceName: "app", portMappings: [{ index: 0, published }] }).success).toBe(false);
  });

  it("rejects missing services, stale mappings and ranges without modifying the source", () => {
    const original = { services: { app: { ports: ["8000-8005:80-85"] } } };
    for (const patch of [
      { serviceName: "missing", env: { TEST: "value" } },
      { serviceName: "app", portMappings: [{ index: 5, published: 8080 }] },
      { serviceName: "app", portMappings: [{ index: 0, published: 8080 }] },
    ]) expect(() => patchComposeConfig(original, patch)).toThrow();
    expect(original.services.app.ports).toEqual(["8000-8005:80-85"]);
  });
});
