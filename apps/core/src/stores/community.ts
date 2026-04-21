/**
 * Community Store Client
 *
 * FUTURE WORK — This module is a placeholder for the Talome community app store.
 * The community backend does not exist yet. When built, it will be a separate
 * service that:
 * - Accepts app submissions (exported bundles)
 * - Stores metadata, ratings, and download counts
 * - Serves as a Git-compatible store that Talome instances can sync
 *
 * Until then, app sharing works via the LOCAL community pipeline:
 * - Users create apps → export as bundles → submit for local admin review
 * - Approved apps live in ~/.talome/community-store/ on that instance only
 *
 * None of the functions below are called in production code.
 * They exist to define the API contract for the future community backend.
 */

// ── Types (stable — used by community-pipeline.ts) ─────────────────────────

export interface CommunityAppMeta {
  appId: string;
  name: string;
  author: string;
  description: string;
  category: string;
  downloads: number;
  rating: number;
  ratingCount: number;
  verified: boolean;
  publishedAt: string;
  updatedAt: string;
  storeUrl: string;
}

export interface PublishRequest {
  manifest: Record<string, unknown>;
  dockerCompose: string;
  authorName: string;
  authorEmail?: string;
}

export interface PublishResult {
  success: boolean;
  appUrl?: string;
  error?: string;
}

// ── Placeholder client (NOT CONNECTED — community backend does not exist) ──

const COMMUNITY_API_URL = process.env.TALOME_COMMUNITY_URL || "https://community.talome.dev/api";

/** @future Publish an app bundle to the community store */
export async function publishToCommunity(_request: PublishRequest): Promise<PublishResult> {
  return {
    success: false,
    error: "Community store is not available yet. Use the local review pipeline instead.",
  };
}

/** @future Browse community apps */
export async function fetchCommunityApps(
  _params: { search?: string; category?: string; sort?: "popular" | "recent" | "rating"; page?: number } = {},
): Promise<{ apps: CommunityAppMeta[]; total: number }> {
  return { apps: [], total: 0 };
}

/** @future Rate a community app */
export async function rateApp(_appId: string, _rating: number): Promise<boolean> {
  return false;
}
