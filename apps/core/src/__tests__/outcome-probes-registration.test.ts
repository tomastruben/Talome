import { describe, it, expect, vi } from "vitest";

// Same DB mock as agent-tools-registration.test.ts — agent.ts reads settings via db.
vi.mock("../db/index.js", () => ({
  db: {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({ get: vi.fn().mockReturnValue(null) }),
        all: vi.fn().mockReturnValue([]),
      }),
    }),
  },
  schema: {
    settings: { key: "key" },
    installedApps: { appId: "app_id" },
    mcpTokens: { tokenHash: "token_hash", id: "id", lastUsedAt: "last_used_at" },
    memories: {},
    verificationResults: {},
  },
}));
vi.mock("../db/audit.js", () => ({ writeAuditEntry: vi.fn() }));
vi.mock("../db/memories.js", () => ({ getTopMemories: vi.fn().mockResolvedValue([]) }));

import { getAllRegisteredTools, getAllTiers, getBaseDomainNames, getDomainNameForTool } from "../ai/tool-registry.js";
import "../ai/agent.js";
import { APP_REGISTRY, getConnectableApp } from "../app-registry/index.js";
import { listProbedApps } from "../verification/index.js";
import { photoManagementStack } from "../stacks/photo-management.js";
import { mediaServerStack } from "../stacks/media-server.js";

describe("verify_app_outcome registration", () => {
  it("is registered, always loaded and read-tier", () => {
    expect(Object.keys(getAllRegisteredTools())).toContain("verify_app_outcome");
    expect(getAllTiers().verify_app_outcome).toBe("read");
    // Always loaded: its domain is a base domain, so every chat turn sees it.
    expect(getBaseDomainNames()).toContain(getDomainNameForTool("verify_app_outcome"));
  });

  it("every probed app has connection details in the app-registry (settings keys come from the registry)", () => {
    for (const appId of listProbedApps()) expect(getConnectableApp(appId), appId).toBeDefined();
    expect(getConnectableApp("immich")?.apiKeySettingKey).toBe("immich_api_key");
    expect(getConnectableApp("jellyseerr")?.apiBaseSettingKey).toBe("jellyseerr_url");
    // User-keyed apps stay out of APP_REGISTRY so health score / setup loop don't manage them.
    expect(APP_REGISTRY.immich).toBeUndefined();
    expect(APP_REGISTRY.jellyseerr).toBeUndefined();
  });
});

describe("photo-management stack (Immich parity)", () => {
  const immich = photoManagementStack.apps.find((a) => a.appId === "immich")!;

  it("ships server, machine-learning, valkey and VectorChord postgres", () => {
    expect(immich.compose).toContain("ghcr.io/immich-app/immich-server:");
    expect(immich.compose).toContain("ghcr.io/immich-app/immich-machine-learning:");
    expect(immich.compose).toMatch(/valkey\/valkey:\d/);
    expect(immich.compose).toMatch(/ghcr\.io\/immich-app\/postgres:14-vectorchord[\d.]+-pgvectors[\d.]+/);
    expect(immich.compose).not.toContain("pgvecto-rs:pg14");
    // Pinned to the verified upstream v3.2.4 layout.
    expect(immich.compose).toContain("ghcr.io/immich-app/immich-server:${IMMICH_VERSION:-v3.2.4}");
    expect(immich.compose).toContain("ghcr.io/immich-app/immich-machine-learning:${IMMICH_VERSION:-v3.2.4}");
    expect(immich.compose).toContain("valkey/valkey:9");
    expect(immich.compose).toContain("ghcr.io/immich-app/postgres:14-vectorchord0.4.3-pgvectors0.2.0");
  });

  it("pins versions (no latest/release tags) and keeps server and ML in lockstep", () => {
    for (const app of photoManagementStack.apps) {
      expect(app.compose).not.toMatch(/:latest\b/);
      expect(app.compose).not.toMatch(/:release\b/);
    }
    const server = immich.compose.match(/immich-server:(\S+)/)?.[1];
    const ml = immich.compose.match(/immich-machine-learning:(\S+)/)?.[1];
    expect(server).toBeTruthy();
    expect(server).toBe(ml);
    const envDefault = immich.configSchema.envVars.find((e) => e.key === "IMMICH_VERSION")?.defaultValue;
    expect(server).toContain(envDefault);
  });

  it("stores photos on a user-selectable drive with relative defaults", () => {
    expect(immich.compose).toContain("${UPLOAD_LOCATION:-./library}:/data");
    expect(immich.compose).toContain("${DB_DATA_LOCATION:-./postgres}:/var/lib/postgresql/data");
    const upload = immich.configSchema.envVars.find((e) => e.key === "UPLOAD_LOCATION");
    expect(upload?.defaultValue).toBe("./library");
    const pw = immich.configSchema.envVars.find((e) => e.key === "DB_PASSWORD");
    expect(pw?.secret).toBe(true);
    expect(pw?.required).toBe(true);
    expect(pw?.defaultValue).toBeUndefined();
    expect(immich.compose).not.toContain("DB_PASSWORD=postgres");
  });

  it("guides iPhone/Android backup and ends with outcome verification", () => {
    const prompt = photoManagementStack.postInstallPrompt ?? "";
    expect(prompt).toMatch(/iPhone/);
    expect(prompt).toMatch(/Android/);
    expect(prompt).toMatch(/Background/);
    expect(prompt).toContain("immich_api_key");
    expect(prompt).toContain('verify_app_outcome with stackId "photo-management"');
    expect(mediaServerStack.postInstallPrompt).toContain('verify_app_outcome with stackId "media-server"');
  });
});
