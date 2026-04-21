import { mkdirSync, existsSync, readFileSync } from "node:fs";
import { atomicWriteFileSync } from "../utils/filesystem.js";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { execSync } from "node:child_process";
import { and, eq } from "drizzle-orm";
import yaml from "js-yaml";
import { db, schema } from "../db/index.js";
import { syncStore } from "./sync.js";

const COMMUNITY_STORE_ID = "talome-community";
const COMMUNITY_STORE_DIR = join(homedir(), ".talome", "community-store");

type CheckStatus = "passed" | "failed";

export interface CommunityCheck {
  id: string;
  label: string;
  status: CheckStatus;
  details?: string;
}

export interface CommunityBundle {
  format: "talome-app-v1";
  app: {
    manifest: Record<string, any>;
    dockerCompose: string;
    creator?: Record<string, any>;
    workspaceFiles?: { path: string; content: string }[];
  };
  metadata?: {
    exportedAt?: string;
    exportedFrom?: string;
  };
}

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function ensureCommunityStoreSource(): void {
  mkdirSync(COMMUNITY_STORE_DIR, { recursive: true });

  const existing = db
    .select()
    .from(schema.storeSources)
    .where(eq(schema.storeSources.id, COMMUNITY_STORE_ID))
    .get();
  if (existing) return;

  db.insert(schema.storeSources)
    .values({
      id: COMMUNITY_STORE_ID,
      name: "Talome Community",
      type: "talome",
      localPath: COMMUNITY_STORE_DIR,
      branch: "main",
      enabled: true,
      appCount: 0,
    })
    .run();
}

function ensureCommunityRegistry(): { version: number; apps: string[] } {
  mkdirSync(join(COMMUNITY_STORE_DIR, "apps"), { recursive: true });
  const registryPath = join(COMMUNITY_STORE_DIR, "registry.json");
  if (!existsSync(registryPath)) {
    const initial = { version: 1, apps: [] as string[] };
    atomicWriteFileSync(registryPath, JSON.stringify(initial, null, 2));
    return initial;
  }
  return parseJson(readFileSync(registryPath, "utf-8"), { version: 1, apps: [] });
}

function runAutomatedChecks(bundle: CommunityBundle): CommunityCheck[] {
  const checks: CommunityCheck[] = [];
  const manifest = bundle.app?.manifest || {};
  const compose = bundle.app?.dockerCompose || "";

  // ── Manifest checks ──────────────────────────────────────────────────

  checks.push({
    id: "manifest-id",
    label: "Manifest contains valid app id",
    status: typeof manifest.id === "string" && /^[a-z0-9][a-z0-9_-]*$/.test(manifest.id) ? "passed" : "failed",
    details: "Use lowercase letters, digits, '-' or '_' only.",
  });

  checks.push({
    id: "manifest-name",
    label: "Manifest contains app name",
    status: typeof manifest.name === "string" && manifest.name.trim().length > 1 ? "passed" : "failed",
  });

  checks.push({
    id: "manifest-description",
    label: "Manifest contains app description",
    status: typeof manifest.description === "string" && manifest.description.trim().length > 10 ? "passed" : "failed",
  });

  checks.push({
    id: "manifest-category",
    label: "Manifest has a valid category",
    status: typeof manifest.category === "string" && manifest.category.trim().length > 0 ? "passed" : "failed",
    details: "Category should be one of: media, productivity, developer, networking, storage, security, ai, other",
  });

  checks.push({
    id: "manifest-version",
    label: "Manifest has a version",
    status: typeof manifest.version === "string" && /^\d+\.\d+/.test(manifest.version) ? "passed" : "failed",
    details: "Use semantic versioning (e.g. 1.0.0).",
  });

  // ── Compose structure checks ────────────────────────────────────────

  checks.push({
    id: "compose-latest-tag",
    label: "Compose does not use :latest tags",
    status: /:\s*.*:latest\b/i.test(compose) ? "failed" : "passed",
    details: "Pin image versions so installs are deterministic.",
  });

  checks.push({
    id: "compose-privileged",
    label: "Compose does not request privileged mode",
    status: /privileged:\s*true/i.test(compose) ? "failed" : "passed",
  });

  // Validate YAML syntax
  let parsedCompose: any = null;
  try {
    parsedCompose = yaml.load(compose);
    checks.push({
      id: "compose-valid-yaml",
      label: "Compose is valid YAML",
      status: parsedCompose && typeof parsedCompose === "object" ? "passed" : "failed",
    });
  } catch (err) {
    checks.push({
      id: "compose-valid-yaml",
      label: "Compose is valid YAML",
      status: "failed",
      details: err instanceof Error ? err.message : "Invalid YAML syntax",
    });
  }

  // Check for services block
  checks.push({
    id: "compose-has-services",
    label: "Compose defines at least one service",
    status: parsedCompose?.services && Object.keys(parsedCompose.services).length > 0 ? "passed" : "failed",
  });

  // Check that all services have images
  if (parsedCompose?.services) {
    const services = Object.entries(parsedCompose.services) as [string, any][];
    const missingImage = services.filter(([, svc]) => !svc?.image && !svc?.build);
    checks.push({
      id: "compose-services-have-images",
      label: "All services specify an image",
      status: missingImage.length === 0 ? "passed" : "failed",
      details: missingImage.length > 0 ? `Missing image: ${missingImage.map(([n]) => n).join(", ")}` : undefined,
    });

    // Check for restart policy
    const noRestart = services.filter(([, svc]) => !svc?.restart);
    checks.push({
      id: "compose-restart-policy",
      label: "Services have restart policies",
      status: noRestart.length === 0 ? "passed" : "failed",
      details: noRestart.length > 0 ? `Missing restart policy: ${noRestart.map(([n]) => n).join(", ")}` : undefined,
    });

    // Check for absolute host paths (should use relative)
    const absolutePaths: string[] = [];
    for (const [name, svc] of services) {
      for (const vol of svc?.volumes ?? []) {
        const path = typeof vol === "string" ? vol.split(":")[0] : vol?.source;
        if (typeof path === "string" && path.startsWith("/") && !path.startsWith("/dev")) {
          absolutePaths.push(`${name}: ${path}`);
        }
      }
    }
    checks.push({
      id: "compose-no-absolute-paths",
      label: "Volumes use relative paths",
      status: absolutePaths.length === 0 ? "passed" : "failed",
      details: absolutePaths.length > 0 ? `Absolute paths: ${absolutePaths.join(", ")}` : undefined,
    });
  }

  return checks;
}

/**
 * Test that all images in a compose file can be pulled.
 * This is an async check run separately from the synchronous validators.
 */
export async function runImagePullTest(compose: string): Promise<CommunityCheck[]> {
  const checks: CommunityCheck[] = [];
  let parsed: any;
  try {
    parsed = yaml.load(compose);
  } catch {
    return [{ id: "image-pull", label: "Image pull test", status: "failed", details: "Cannot parse compose YAML" }];
  }

  if (!parsed?.services) return checks;

  for (const [name, svc] of Object.entries(parsed.services) as [string, any][]) {
    const image = svc?.image;
    if (!image || typeof image !== "string") continue;

    try {
      // Use --quiet to reduce output — we only care about success/failure
      execSync(`docker pull "${image}" --quiet`, { timeout: 120_000, stdio: "pipe" });
      checks.push({
        id: `image-pull-${name}`,
        label: `Image pullable: ${image}`,
        status: "passed",
      });
    } catch {
      checks.push({
        id: `image-pull-${name}`,
        label: `Image pullable: ${image}`,
        status: "failed",
        details: `Failed to pull ${image} — verify the image exists and the tag is correct.`,
      });
    }
  }

  return checks;
}

function writeAppToCommunityMirror(bundle: CommunityBundle): { success: boolean; error?: string } {
  const manifest = bundle.app.manifest || {};
  const appId = String(manifest.id || "").trim();
  if (!appId) return { success: false, error: "Missing app id" };

  ensureCommunityStoreSource();
  const registry = ensureCommunityRegistry();
  const appDir = join(COMMUNITY_STORE_DIR, "apps", appId);
  mkdirSync(appDir, { recursive: true });

  const normalizedManifest = {
    ...manifest,
    id: appId,
    name: manifest.name || appId,
    description: manifest.description || "",
    category: manifest.category || "other",
    version: manifest.version || "1.0.0",
    author: manifest.author || "Community",
  };

  atomicWriteFileSync(join(appDir, "manifest.json"), JSON.stringify(normalizedManifest, null, 2));
  atomicWriteFileSync(join(appDir, "docker-compose.yml"), bundle.app.dockerCompose || "");
  if (bundle.app.creator) {
    atomicWriteFileSync(join(appDir, "creator.json"), JSON.stringify(bundle.app.creator, null, 2));
  }

  if (!registry.apps.includes(appId)) {
    registry.apps.push(appId);
    atomicWriteFileSync(join(COMMUNITY_STORE_DIR, "registry.json"), JSON.stringify(registry, null, 2));
  }

  return { success: true };
}

export async function submitCommunityBundle(input: {
  bundle: CommunityBundle;
  authorName: string;
  authorEmail?: string;
}): Promise<{ success: boolean; submissionId?: string; checks?: CommunityCheck[]; error?: string }> {
  if (input.bundle?.format !== "talome-app-v1") {
    return { success: false, error: "Unsupported bundle format" };
  }

  const manifest = input.bundle?.app?.manifest;
  const compose = input.bundle?.app?.dockerCompose;
  if (!manifest || typeof manifest !== "object" || !compose || typeof compose !== "string") {
    return { success: false, error: "Bundle is missing manifest or docker-compose data" };
  }

  const checks = runAutomatedChecks(input.bundle);
  const submissionId = randomUUID().slice(0, 12);
  const appId = String(manifest.id || "unknown");
  const appName = String(manifest.name || appId);

  db.insert(schema.communitySubmissions)
    .values({
      id: submissionId,
      appId,
      appName,
      authorName: input.authorName || "Unknown",
      authorEmail: input.authorEmail || null,
      status: "pending_review",
      bundleJson: JSON.stringify(input.bundle),
      checksJson: JSON.stringify(checks),
    })
    .run();

  return { success: true, submissionId, checks };
}

export function listCommunitySubmissions(status?: "pending_review" | "approved" | "rejected") {
  const rows = status
    ? db
        .select()
        .from(schema.communitySubmissions)
        .where(eq(schema.communitySubmissions.status, status))
        .all()
    : db.select().from(schema.communitySubmissions).all();

  return rows.map((row) => ({
    id: row.id,
    appId: row.appId,
    appName: row.appName,
    authorName: row.authorName,
    authorEmail: row.authorEmail,
    status: row.status,
    checks: parseJson<CommunityCheck[]>(row.checksJson, []),
    reviewNotes: row.reviewNotes,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    publishedAt: row.publishedAt,
  }));
}

export async function reviewCommunitySubmission(
  submissionId: string,
  decision: "approved" | "rejected",
  notes?: string,
  options?: { skipImagePullTest?: boolean },
): Promise<{ success: boolean; error?: string; imagePullChecks?: CommunityCheck[] }> {
  const row = db
    .select()
    .from(schema.communitySubmissions)
    .where(eq(schema.communitySubmissions.id, submissionId))
    .get();
  if (!row) return { success: false, error: "Submission not found" };

  if (decision === "approved") {
    const bundle = parseJson<CommunityBundle | null>(row.bundleJson, null);
    if (!bundle) return { success: false, error: "Invalid bundle payload" };

    // Run image pull test before approval (unless skipped)
    if (!options?.skipImagePullTest) {
      const pullChecks = await runImagePullTest(bundle.app.dockerCompose || "");
      const failedPulls = pullChecks.filter((c) => c.status === "failed");
      if (failedPulls.length > 0) {
        return {
          success: false,
          error: `Image pull test failed: ${failedPulls.map((c) => c.details).join("; ")}`,
          imagePullChecks: pullChecks,
        };
      }
    }

    const mirrorResult = writeAppToCommunityMirror(bundle);
    if (!mirrorResult.success) return mirrorResult;

    await syncStore(COMMUNITY_STORE_ID);
  } else {
    // Remove any already-published catalog entry if a submission gets rejected later.
    db.delete(schema.appCatalog)
      .where(
        and(
          eq(schema.appCatalog.storeSourceId, COMMUNITY_STORE_ID),
          eq(schema.appCatalog.appId, row.appId),
        ),
      )
      .run();
  }

  db.update(schema.communitySubmissions)
    .set({
      status: decision,
      reviewNotes: notes || null,
      updatedAt: new Date().toISOString(),
      publishedAt: decision === "approved" ? new Date().toISOString() : null,
    })
    .where(eq(schema.communitySubmissions.id, submissionId))
    .run();

  return { success: true };
}
