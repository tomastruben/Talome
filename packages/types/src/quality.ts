// ── Quality Tier System ───────────────────────────────────────────────────────
// Single source of truth for quality tiers, profile matching, and release scoring.
// No I/O — pure types, constants, and functions.

// ── Types ────────────────────────────────────────────────────────────────────

export type QualityTier = "compact" | "standard" | "premium";

export type MediaCategory = "movie" | "episode";

export type LegacyQualityIntent = "efficient" | "balanced" | "cinephile";

export interface TierSpec {
  id: QualityTier;
  label: string;
  hint: string;
  profileTokens: readonly string[];
  maxSizeGb: Readonly<Record<MediaCategory, number>>;
  scoring: Readonly<{
    resolutionBonus: number;
    codecBonus: number;
    sourceBonus: number;
    sizeFitBonus: number;
    oversizePenalty: number;
    preferredResolutions: readonly string[];
    preferredSources: readonly string[];
    preferSmallCodec: boolean;
  }>;
}

export interface ProfileMatchResult {
  profileId: number;
  profileName: string | null;
  matchMethod: "exact-token" | "closest-match" | "first-available" | "hardcoded-default";
  fallbackUsed: boolean;
  reason: string;
}

export interface ReleaseScoreBreakdown {
  resolution: number;
  codec: number;
  source: number;
  sizeFit: number;
  seeders: number;
  age: number;
  format: number;
}

export interface ReleaseScore {
  total: number;
  breakdown: ReleaseScoreBreakdown;
}

export interface ReleaseInput {
  title: string;
  qualityName: string;
  size: number;
  ageHours: number;
  seeders?: number | null;
}

// ── Constants ────────────────────────────────────────────────────────────────

// All tiers use the same broad profile tokens — the widest profile available.
// Tiers differ ONLY by size budget and scoring weights.
const BROAD_PROFILE_TOKENS = ["any", "ultra", "2160", "4k", "1080", "720"] as const;

export const QUALITY_TIERS: readonly TierSpec[] = [
  {
    id: "compact",
    label: "Compact",
    hint: "Up to 4 GB",
    profileTokens: BROAD_PROFILE_TOKENS,
    maxSizeGb: { movie: 4, episode: 1.5 },
    scoring: {
      resolutionBonus: 15,
      codecBonus: 20,
      sourceBonus: 10,
      sizeFitBonus: 30,
      oversizePenalty: 40,
      preferredResolutions: ["2160", "4k", "1080", "720"],
      preferredSources: ["web", "webdl", "webrip"],
      preferSmallCodec: true,
    },
  },
  {
    id: "standard",
    label: "Standard",
    hint: "Up to 12 GB",
    profileTokens: BROAD_PROFILE_TOKENS,
    maxSizeGb: { movie: 12, episode: 4 },
    scoring: {
      resolutionBonus: 20,
      codecBonus: 12,
      sourceBonus: 10,
      sizeFitBonus: 20,
      oversizePenalty: 35,
      preferredResolutions: ["2160", "4k", "1080"],
      preferredSources: ["web", "bluray", "webdl"],
      preferSmallCodec: true,
    },
  },
  {
    id: "premium",
    label: "Premium",
    hint: "Up to 40 GB",
    profileTokens: BROAD_PROFILE_TOKENS,
    maxSizeGb: { movie: 40, episode: 8 },
    scoring: {
      resolutionBonus: 35,
      codecBonus: 0,
      sourceBonus: 25,
      sizeFitBonus: 12,
      oversizePenalty: 8,
      preferredResolutions: ["2160", "4k", "1080"],
      preferredSources: ["remux", "bluray"],
      preferSmallCodec: false,
    },
  },
] as const;

export const DEFAULT_TIER: QualityTier = "standard";

export const LEGACY_INTENT_MAP: Readonly<Record<LegacyQualityIntent, QualityTier>> = {
  efficient: "compact",
  balanced: "standard",
  cinephile: "premium",
};

// ── Pure Functions ───────────────────────────────────────────────────────────

/** Normalize any tier or legacy intent string to a valid QualityTier. */
export function normalizeTier(raw: string | undefined | null): QualityTier {
  if (!raw) return DEFAULT_TIER;
  const lower = raw.toLowerCase().trim();
  if (lower in LEGACY_INTENT_MAP) return LEGACY_INTENT_MAP[lower as LegacyQualityIntent];
  const found = QUALITY_TIERS.find((t) => t.id === lower);
  if (found) return found.id;
  return DEFAULT_TIER;
}

/** Get the full tier spec for a given tier ID. */
export function getTierSpec(tier: QualityTier): TierSpec {
  return QUALITY_TIERS.find((t) => t.id === tier) ?? QUALITY_TIERS[1]; // standard fallback
}

/** Get the size budget in GB for a tier + media category. */
export function getMaxSizeGb(tier: QualityTier, category: MediaCategory): number {
  return getTierSpec(tier).maxSizeGb[category];
}

/**
 * Match a tier to an Arr quality profile using a 4-step fallback chain:
 * 1. Token match — scan profile names for tier's tokens in order
 * 2. Closest match — profile with most token overlaps
 * 3. First available — profiles[0]
 * 4. Hardcoded default — ID 1
 */
export function matchProfile(
  profiles: Array<{ id: number; name?: string | null }>,
  tier: QualityTier,
): ProfileMatchResult {
  const spec = getTierSpec(tier);

  if (!profiles.length) {
    return {
      profileId: 1,
      profileName: null,
      matchMethod: "hardcoded-default",
      fallbackUsed: true,
      reason: "No profiles available; using default",
    };
  }

  // Step 1: Token match — first token that matches a profile name wins
  for (const token of spec.profileTokens) {
    const match = profiles.find((p) => (p.name ?? "").toLowerCase().includes(token));
    if (match) {
      return {
        profileId: match.id,
        profileName: match.name ?? null,
        matchMethod: "exact-token",
        fallbackUsed: false,
        reason: `Matched '${match.name}' via token '${token}'`,
      };
    }
  }

  // Step 2: Closest match — profile with most token overlaps
  let bestProfile = profiles[0];
  let bestOverlap = 0;
  for (const p of profiles) {
    const name = (p.name ?? "").toLowerCase();
    let overlap = 0;
    for (const token of spec.profileTokens) {
      if (name.includes(token)) overlap++;
    }
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      bestProfile = p;
    }
  }

  if (bestOverlap > 0) {
    return {
      profileId: bestProfile.id,
      profileName: bestProfile.name ?? null,
      matchMethod: "closest-match",
      fallbackUsed: true,
      reason: `Best overlap: '${bestProfile.name}' (${bestOverlap} token${bestOverlap > 1 ? "s" : ""})`,
    };
  }

  // Step 3: First available
  const first = profiles[0];
  return {
    profileId: first.id,
    profileName: first.name ?? null,
    matchMethod: "first-available",
    fallbackUsed: true,
    reason: `No token overlap; using first available '${first.name}'`,
  };
}

/**
 * Multi-dimensional release scoring with transparent breakdown.
 * Considers resolution, codec, source, size fit, seeders, age, and container format.
 */
export function scoreRelease(
  release: ReleaseInput,
  tier: QualityTier,
  category: MediaCategory,
  options?: { preferMp4?: boolean },
): ReleaseScore {
  const spec = getTierSpec(tier);
  const { scoring } = spec;
  const title = release.title.toLowerCase();
  const qualityName = release.qualityName.toLowerCase();
  const maxBytes = getMaxSizeGb(tier, category) * 1024 * 1024 * 1024;

  const breakdown: ReleaseScoreBreakdown = {
    resolution: 0,
    codec: 0,
    source: 0,
    sizeFit: 0,
    seeders: 0,
    age: 0,
    format: 0,
  };

  // ── Resolution ──
  for (let i = 0; i < scoring.preferredResolutions.length; i++) {
    const keyword = scoring.preferredResolutions[i];
    if (qualityName.includes(keyword) || title.includes(keyword)) {
      // First preferred resolution gets full bonus, later ones get proportionally less
      const factor = 1 - i * 0.15;
      breakdown.resolution = Math.round(scoring.resolutionBonus * Math.max(factor, 0.5));
      break;
    }
  }

  // ── Codec ──
  if (scoring.preferSmallCodec) {
    if (title.includes("x265") || title.includes("hevc") || title.includes("h.265") || title.includes("h265")) {
      breakdown.codec = scoring.codecBonus;
    } else if (title.includes("x264") || title.includes("avc") || title.includes("h.264") || title.includes("h264")) {
      breakdown.codec = Math.round(scoring.codecBonus * 0.5);
    }
  }

  // ── Source ──
  for (const keyword of scoring.preferredSources) {
    if (title.includes(keyword)) {
      breakdown.source = scoring.sourceBonus;
      break;
    }
  }

  // ── Size fit ──
  if (release.size > 0) {
    if (release.size <= maxBytes) {
      breakdown.sizeFit = scoring.sizeFitBonus;
    } else if (release.size <= maxBytes * 1.5) {
      breakdown.sizeFit = -Math.round(scoring.oversizePenalty * 0.5);
    } else {
      breakdown.sizeFit = -scoring.oversizePenalty;
    }
  }

  // ── Seeders ──
  if (release.seeders != null) {
    if (release.seeders === 0) {
      breakdown.seeders = -10;
    } else {
      breakdown.seeders = Math.min(15, release.seeders);
    }
  }

  // ── Age ──
  if (release.ageHours > 0) {
    breakdown.age = -Math.min(20, Math.floor(release.ageHours / 24));
  }

  // ── Container format ──
  // Compact and Standard always prefer MP4 (browser-playable).
  // Premium doesn't care. Explicit preferMp4 option overrides for any tier.
  const wantsMp4 = options?.preferMp4 || tier !== "premium";
  if (wantsMp4) {
    if (title.includes(".mp4") || title.endsWith(" mp4")) {
      breakdown.format = 15;
    } else if (title.includes(".mkv") || title.endsWith(" mkv")) {
      breakdown.format = -5;
    }
  }

  const total = breakdown.resolution + breakdown.codec + breakdown.source
    + breakdown.sizeFit + breakdown.seeders + breakdown.age + breakdown.format;

  return { total, breakdown };
}
