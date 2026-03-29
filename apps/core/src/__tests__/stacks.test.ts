import { describe, it, expect } from "vitest";
import { sanitizeStackForExport } from "../routes/stacks.js";
import { mediaServerStack } from "../stacks/media-server.js";
import { smartHomeStack } from "../stacks/smart-home.js";
import { privacySuiteStack } from "../stacks/privacy-suite.js";
import { developerLabStack } from "../stacks/developer-lab.js";

describe("sanitizeStackForExport", () => {
  it("replaces secret env var values with placeholders in compose YAML", () => {
    const exported = sanitizeStackForExport(privacySuiteStack);
    const piholeApp = exported.apps.find((a) => a.appId === "pihole");
    expect(piholeApp).toBeDefined();
    // The compose YAML should have placeholder for WEBPASSWORD
    expect(piholeApp!.compose).toContain("<PLACEHOLDER:");
  });

  it("does not replace non-secret env var values", () => {
    const exported = sanitizeStackForExport(mediaServerStack);
    const jellyfinApp = exported.apps.find((a) => a.appId === "jellyfin");
    expect(jellyfinApp).toBeDefined();
    // PUID and TZ should not be replaced
    expect(jellyfinApp!.compose).toContain("PUID=1000");
    expect(jellyfinApp!.compose).not.toContain("PUID=<PLACEHOLDER:");
  });

  it("preserves all app IDs after sanitization", () => {
    const exported = sanitizeStackForExport(mediaServerStack);
    const appIds = exported.apps.map((a) => a.appId);
    expect(appIds).toContain("sonarr");
    expect(appIds).toContain("radarr");
    expect(appIds).toContain("jellyfin");
    expect(appIds).toContain("qbittorrent");
    expect(appIds).toContain("overseerr");
  });

  it("does not mutate the original stack", () => {
    const original = privacySuiteStack.apps.find((a) => a.appId === "vaultwarden");
    const originalCompose = original!.compose;
    sanitizeStackForExport(privacySuiteStack);
    // Original should be unchanged
    expect(original!.compose).toBe(originalCompose);
  });
});

describe("built-in stack templates", () => {
  const allStacks = [mediaServerStack, smartHomeStack, privacySuiteStack, developerLabStack];

  it("all 4 built-in stacks are defined", () => {
    expect(allStacks).toHaveLength(4);
  });

  it.each(allStacks)("stack $name has required fields", (stack) => {
    expect(stack.id).toBeTruthy();
    expect(stack.name).toBeTruthy();
    expect(stack.description).toBeTruthy();
    expect(stack.tags).toBeInstanceOf(Array);
    expect(stack.apps).toBeInstanceOf(Array);
    expect(stack.apps.length).toBeGreaterThan(0);
    expect(stack.version).toBeTruthy();
  });

  it.each(allStacks)("all apps in $name have compose YAML", (stack) => {
    for (const app of stack.apps) {
      expect(app.appId).toBeTruthy();
      expect(app.name).toBeTruthy();
      expect(app.compose).toBeTruthy();
      expect(app.compose).toContain("services:");
      expect(app.configSchema.envVars).toBeInstanceOf(Array);
    }
  });

  it("media-server stack has a postInstallPrompt", () => {
    expect(mediaServerStack.postInstallPrompt).toBeTruthy();
    expect(mediaServerStack.postInstallPrompt!.length).toBeGreaterThan(50);
  });

  it("media-server stack includes all 6 expected apps", () => {
    const ids = mediaServerStack.apps.map((a) => a.appId);
    expect(ids).toContain("jellyfin");
    expect(ids).toContain("sonarr");
    expect(ids).toContain("radarr");
    expect(ids).toContain("prowlarr");
    expect(ids).toContain("qbittorrent");
    expect(ids).toContain("overseerr");
  });

  it("privacy-suite has vaultwarden with ADMIN_TOKEN as secret", () => {
    const vw = privacySuiteStack.apps.find((a) => a.appId === "vaultwarden");
    const adminTokenVar = vw?.configSchema.envVars.find((e) => e.key === "ADMIN_TOKEN");
    expect(adminTokenVar?.secret).toBe(true);
    expect(adminTokenVar?.required).toBe(true);
  });
});

describe("stack IDs are unique", () => {
  it("no two stacks share an ID", () => {
    const allStacks = [mediaServerStack, smartHomeStack, privacySuiteStack, developerLabStack];
    const ids = allStacks.map((s) => s.id);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(ids.length);
  });
});
