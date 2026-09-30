import { describe, expect, it } from "vitest";
import {
  dependencyCandidates,
  formStateToOptions,
  installBlockReason,
  parseInstallPlan,
  planHasChoices,
  planToFormState,
  validateFormState,
  type UmbrelInstallPlan,
} from "@/lib/umbrel-install";

const RESPONSE = {
  appId: "immich",
  storeId: "umbrel",
  umbrel: {},
  plan: {
    supported: true,
    blockers: [],
    warnings: [
      'Folder "Photos" is mounted read-only from /mnt/media. Choose a folder at install time to give the app write access.',
      'Several installed apps provide "database" (mariadb, postgres); using "mariadb".',
    ],
    folders: [
      {
        id: "photos",
        name: "Photos",
        note: "Where your library lives",
        mounts: [{ service: "server", targetPath: "/photos", readOnly: true }],
        defaultSource: "/mnt/media",
        source: "/mnt/media",
        userSelected: false,
        sharedDefault: true,
      },
      {
        id: "uploads",
        name: "Uploads",
        mounts: [{ service: "server", targetPath: "/uploads", readOnly: false }],
        defaultSource: "/data/apps/immich/uploads",
        source: "/data/apps/immich/uploads",
        userSelected: false,
      },
    ],
    environment: [
      { name: "LOG_LEVEL", services: ["server"], default: "info", options: ["debug", "info", "warn"], origin: "none" },
      { name: "PUBLIC_URL", services: ["server"], origin: "none" },
    ],
    dependencies: [{ dependency: "database", provider: "mariadb", viaImplements: true }],
    missingDependencies: [],
    serviceEnv: {},
  },
};

function plan(): UmbrelInstallPlan {
  const parsed = parseInstallPlan(RESPONSE);
  if (!parsed) throw new Error("plan did not parse");
  return parsed;
}

describe("parseInstallPlan", () => {
  it("parses the install-plan response", () => {
    const p = plan();
    expect(p.folders.map((f) => f.id)).toEqual(["photos", "uploads"]);
    expect(p.folders[0].sharedDefault).toBe(true);
    expect(p.environment[0].options).toEqual(["debug", "info", "warn"]);
    expect(p.dependencies[0]).toMatchObject({ dependency: "database", provider: "mariadb" });
  });

  it("rejects malformed payloads", () => {
    expect(parseInstallPlan(null)).toBeNull();
    expect(parseInstallPlan({ plan: { folders: [] } })).toBeNull();
  });
});

describe("installBlockReason", () => {
  it("explains unsupported (torOnly) apps", () => {
    const torOnly = parseInstallPlan({
      plan: { supported: false, unsupportedReason: "This app is Tor-only (torOnly: true).", blockers: ["This app is Tor-only (torOnly: true)."], warnings: [] },
    });
    expect(installBlockReason(torOnly)).toBe("This app is Tor-only (torOnly: true).");
  });

  it("blocks on missing dependencies and blockers, not otherwise", () => {
    expect(installBlockReason(parseInstallPlan({ plan: { supported: true, missingDependencies: ["bitcoin"] } }))).toBe(
      "Requires bitcoin. Install it first.",
    );
    expect(installBlockReason(parseInstallPlan({ plan: { supported: true, blockers: ['Folder "x": bad path.'] } }))).toBe(
      'Folder "x": bad path.',
    );
    expect(installBlockReason(plan())).toBeNull();
    expect(installBlockReason(null)).toBeNull();
  });
});

describe("plan to form mapping", () => {
  it("prefills folders with plan defaults and env with defaults", () => {
    const state = planToFormState(plan());
    expect(state.folders).toEqual({ photos: "/mnt/media", uploads: "/data/apps/immich/uploads" });
    expect(state.environment).toEqual({ LOG_LEVEL: "info", PUBLIC_URL: "" });
    expect(state.dependencies).toEqual({ database: "mariadb" });
  });

  it("offers dependency providers from the plan warning", () => {
    const p = plan();
    expect(dependencyCandidates(p, p.dependencies[0])).toEqual(["mariadb", "postgres"]);
    expect(planHasChoices(p)).toBe(true);
  });

  it("uses explicit candidates when the plan provides them", () => {
    const p = plan();
    expect(dependencyCandidates(p, { dependency: "cache", provider: null, viaImplements: false, candidates: ["redis", "valkey"] })).toEqual([
      "redis",
      "valkey",
    ]);
  });

  it("sends nothing when the user changed nothing", () => {
    const p = plan();
    expect(formStateToOptions(p, planToFormState(p))).toBeUndefined();
  });

  it("sends only changed values, plus explicit write access to a shared folder", () => {
    const p = plan();
    const state = planToFormState(p);
    state.folders.uploads = " /mnt/photos/uploads ";
    state.folderWrite.photos = true;
    state.environment.LOG_LEVEL = "debug";
    state.environment.PUBLIC_URL = "https://photos.example";
    state.dependencies.database = "postgres";
    expect(formStateToOptions(p, state)).toEqual({
      folders: { photos: "/mnt/media", uploads: "/mnt/photos/uploads" },
      environment: { LOG_LEVEL: "debug", PUBLIC_URL: "https://photos.example" },
      dependencies: { database: "postgres" },
    });
  });

  it("validates folders and env values", () => {
    const p = plan();
    const state = planToFormState(p);
    state.folders.photos = "relative/path";
    state.folders.uploads = "/mnt/../etc";
    state.environment.LOG_LEVEL = "verbose";
    state.environment.PUBLIC_URL = "a\nb";
    expect(validateFormState(p, state)).toEqual({
      "folder:photos": "Use an absolute path, e.g. /mnt/media",
      "folder:uploads": "The path must not contain ..",
      "env:LOG_LEVEL": "Choose one of: debug, info, warn",
      "env:PUBLIC_URL": "Line breaks and control characters are not allowed",
    });
    expect(validateFormState(p, planToFormState(p))).toEqual({});
  });

  it("plans without folders, env or provider choices need no dialog", () => {
    expect(planHasChoices(parseInstallPlan({ plan: { supported: true, dependencies: [{ dependency: "db", provider: "db" }] } }))).toBe(false);
  });
});
