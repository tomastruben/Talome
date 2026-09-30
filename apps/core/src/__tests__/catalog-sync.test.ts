/**
 * stores/catalog-sync.ts — merging catalog compose changes into an installed
 * app's override. Pure merge tests plus the base files next to the override.
 */
import { describe, it, expect } from "vitest";
import yaml from "js-yaml";
import { mergeCatalogConfig, describeKeptConfig } from "../stores/catalog-sync.js";

type Doc = { services: Record<string, Record<string, unknown>> };

function dump(doc: unknown): string {
  return yaml.dump(doc);
}

describe("updates never apply privilege or host-access changes from the catalog", () => {
  const ESCALATION = {
    privileged: true,
    devices: ["/dev/mem:/dev/mem"],
    pid: "host",
    ipc: "host",
    userns_mode: "host",
    security_opt: ["seccomp:unconfined"],
    cap_add: ["SYS_ADMIN"],
    volumes_from: ["other"],
    env_file: ["/etc/shadow"],
    user: "0:0",
    sysctls: { "net.ipv4.ip_forward": 1 },
  };

  it("keeps them out of the override on the three-way path and reports them for review", () => {
    const base = { services: { app: { image: "x:1", environment: { A: "1" } } } };
    const override: Doc = { services: { app: { image: "x:1", environment: { A: "1" }, cap_drop: ["ALL"] } } };
    const catalog = { services: { app: { image: "x:2", environment: { A: "2" }, ...ESCALATION } } };

    const result = mergeCatalogConfig(override, dump(catalog), dump(base));

    expect(override.services.app).toEqual({ image: "x:1", environment: { A: "2" }, cap_drop: ["ALL"] });
    expect(result.changes).toEqual([{ service: "app", key: "environment", variable: "A", change: "set" }]);
    expect(result.kept.map((k) => k.key).sort()).toEqual(Object.keys(ESCALATION).sort());
    expect(result.kept.every((k) => k.reason === "requires_review")).toBe(true);
    expect(describeKeptConfig(result.kept)).toContain("privileges or host access");
  });

  it("keeps them out on the no-base (legacy) path too", () => {
    const override: Doc = { services: { app: { image: "x:1" } } };
    const catalog = { services: { app: { image: "x:2", restart: "always", ...ESCALATION } } };

    const result = mergeCatalogConfig(override, dump(catalog), null);

    expect(override.services.app).toEqual({ image: "x:1", restart: "always" });
    expect(result.changes).toEqual([{ service: "app", key: "restart", change: "set" }]);
    expect(result.kept.map((k) => k.key).sort()).toEqual(Object.keys(ESCALATION).sort());
  });

  it("a catalog dropping cap_add does not leave the hardened container with no capabilities", () => {
    // Install: the catalog had no cap_drop, so Talome added cap_drop [ALL] and kept the catalog's cap_add.
    const base = { services: { vpn: { image: "v:1", cap_add: ["NET_ADMIN"] } } };
    const override: Doc = { services: { vpn: { image: "v:1", cap_add: ["NET_ADMIN"], cap_drop: ["ALL"] } } };
    const catalog = { services: { vpn: { image: "v:2" } } };

    const result = mergeCatalogConfig(override, dump(catalog), dump(base));

    expect(override.services.vpn.cap_add).toEqual(["NET_ADMIN"]);
    expect(override.services.vpn.cap_drop).toEqual(["ALL"]);
    expect(result.changes).toEqual([]);
    expect(result.kept).toEqual([{ service: "vpn", key: "cap_add", reason: "requires_review" }]);
  });

  it("does not report keys the catalog left alone, nor Talome's own hardening", () => {
    const base = { services: { app: { image: "x:1", cap_add: ["CHOWN"] } } };
    const override: Doc = { services: { app: { image: "x:1", cap_add: ["CHOWN"], cap_drop: ["ALL"], ports: ["18080:80"] } } };
    const catalog = { services: { app: { image: "x:2", cap_add: ["CHOWN"], ports: ["8080:80"] } } };

    const result = mergeCatalogConfig(override, dump(catalog), dump(base));
    expect(result).toEqual({ changes: [], kept: [] });
  });
});
