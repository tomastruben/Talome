import { beforeAll, describe, it, expect } from "vitest";
import { sanitizeStackForExport, stacks } from "../routes/stacks.js";
import { runMigrations } from "../db/migrate.js";
import { mediaServerStack } from "../stacks/media-server.js";
import { smartHomeStack } from "../stacks/smart-home.js";
import { privacySuiteStack } from "../stacks/privacy-suite.js";
import { developerLabStack } from "../stacks/developer-lab.js";

beforeAll(() => {
  runMigrations();
});

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

  it("sanitizes mapping-style environment values and secret defaults", () => {
    const exported = sanitizeStackForExport({
      id: "mapping-secrets",
      name: "Mapping secrets",
      description: "Test stack",
      tagline: "Test",
      author: "test",
      tags: ["test"],
      version: "1.0.0",
      createdAt: "2026-07-20T00:00:00Z",
      apps: [{
        appId: "example",
        name: "Example",
        compose: "services:\n  example:\n    environment:\n      API_TOKEN: real-token\n      - 'ADMIN_PASSWORD=real-password'\n      TZ: Europe/Zurich\n",
        configSchema: {
          envVars: [
            { key: "API_TOKEN", description: "API token", required: true, secret: true, defaultValue: "real-token" },
            { key: "TZ", description: "Timezone", required: false, defaultValue: "Europe/Zurich" },
          ],
        },
      }],
    });

    expect(exported.apps[0].compose).toContain('API_TOKEN: "<PLACEHOLDER: API_TOKEN>"');
    expect(exported.apps[0].compose).toContain("'ADMIN_PASSWORD=<PLACEHOLDER: ADMIN_PASSWORD>'");
    expect(exported.apps[0].compose).toContain("TZ: Europe/Zurich");
    expect(exported.apps[0].configSchema.envVars[0].defaultValue).toBe("<PLACEHOLDER: API_TOKEN>");
  });
});

describe("stack share-code import", () => {
  it("round-trips a VPN-independent capsule into a catalog-aware preview", async () => {
    const shareResponse = await stacks.request("/share-capsule", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stack: privacySuiteStack }),
    });
    expect(shareResponse.status).toBe(200);
    const shared = await shareResponse.json() as {
      capsuleCode: string;
      fileCode: string;
      fingerprint: string;
      qrEligible: boolean;
      linkCompatible: boolean;
      privacy: Record<string, boolean>;
    };
    expect(shared.capsuleCode).toMatch(/^t2\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{12}$/);
    expect(shared.fileCode).toMatch(/^t1\./);
    expect(shared.capsuleCode.endsWith(`.${shared.fingerprint}`)).toBe(true);
    expect(shared.qrEligible).toBe(true);
    expect(shared.linkCompatible).toBe(true);
    expect(shared.capsuleCode.length).toBeLessThan(shared.fileCode.length);
    expect(shared.privacy).toEqual({
      includesCompose: false,
      includesValues: false,
      includesServerAddress: false,
    });

    const payload = shared.capsuleCode.slice(3).split(".")[0];
    const capsuleJson = JSON.parse(Buffer.from(payload, "base64url").toString("utf-8"));
    expect(JSON.stringify(capsuleJson)).not.toContain("compose");
    expect(JSON.stringify(capsuleJson)).not.toContain("real-token");

    const importResponse = await stacks.request("/import-code", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: `https://talome.dev/share/#${shared.capsuleCode}` }),
    });
    expect(importResponse.status).toBe(200);
    const imported = await importResponse.json() as {
      valid: boolean;
      stack: { name: string; apps: { appId: string; available: boolean; installed: boolean }[] };
      requiredInputs: { appId: string; key: string }[];
    };

    expect(imported.valid).toBe(true);
    expect(imported.stack.name).toBe(privacySuiteStack.name);
    expect(imported.stack.apps.map((app) => app.appId)).toEqual(["pihole", "vaultwarden"]);
    expect(imported.requiredInputs).toEqual(expect.arrayContaining([
      expect.objectContaining({ appId: "pihole", key: "WEBPASSWORD" }),
      expect.objectContaining({ appId: "vaultwarden", key: "ADMIN_TOKEN" }),
    ]));
    expect(imported.stack.apps[0]).not.toHaveProperty("compose");
  });

  it("keeps the sanitized full-stack file as an import fallback", async () => {
    const shareResponse = await stacks.request("/share-capsule", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stack: privacySuiteStack }),
    });
    const shared = await shareResponse.json() as {
      recipeFileCode: string;
      recipeFileName: string;
      recoveryFileCode: string;
      recoveryFileName: string;
    };

    expect(shared.recipeFileName).toBe("privacy-suite.talome-stack");
    expect(shared.recipeFileCode).toMatch(/^t2\./);
    expect(shared.recoveryFileName).toBe("privacy-suite.talome-recovery");
    expect(shared.recoveryFileCode).toMatch(/^t1\./);
    const importResponse = await stacks.request("/import-code", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: shared.recoveryFileCode }),
    });
    expect(importResponse.status).toBe(200);
  });

  it("rejects a capsule whose payload no longer matches its fingerprint", async () => {
    const shareResponse = await stacks.request("/share-capsule", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stack: privacySuiteStack }),
    });
    const shared = await shareResponse.json() as { capsuleCode: string };
    const [payload, fingerprint] = shared.capsuleCode.slice(3).split(".");
    const capsule = JSON.parse(Buffer.from(payload, "base64url").toString("utf-8"));
    capsule.name = "Modified stack";
    const tampered = `t2.${Buffer.from(JSON.stringify(capsule), "utf-8").toString("base64url")}.${fingerprint}`;

    const response = await stacks.request("/import-code", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: tampered }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Capsule integrity check failed" });
  });

  it("continues to accept t2 capsules created before fingerprints were added", async () => {
    const shareResponse = await stacks.request("/share-capsule", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stack: privacySuiteStack }),
    });
    const shared = await shareResponse.json() as { capsuleCode: string };
    const legacyCapsule = `t2.${shared.capsuleCode.slice(3).split(".")[0]}`;

    const response = await stacks.request("/import-code", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: legacyCapsule }),
    });
    expect(response.status).toBe(200);
    expect((await response.json() as { valid: boolean }).valid).toBe(true);
  });

  it("continues to accept legacy uncompressed share codes", async () => {
    const legacyCode = Buffer.from(JSON.stringify(privacySuiteStack)).toString("base64url");
    const response = await stacks.request("/import-code", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: legacyCode }),
    });

    expect(response.status).toBe(200);
  });

  it("rejects a code whose nested stack shape is invalid", async () => {
    const code = Buffer.from(JSON.stringify({ id: "unsafe", name: "Unsafe", apps: [{}] })).toString("base64url");
    const response = await stacks.request("/import-code", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    });

    expect(response.status).toBe(400);
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
