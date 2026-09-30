// ── Which image refs in an app's override compose Talome may move ─────────────
//
// An update moves the override compose's `image:` refs to the catalog's
// current ones (stores/lifecycle.ts syncOverrideImageRefs). A ref the user
// chose — pinned with upgrade_app_image, or edited by hand to a fork or
// another tag — must survive that, unless the user asks for the catalog's.
//
// Per app we remember (settings key `app_image_refs:<appId>`):
//   managed — every ref Talome itself wrote per service (install, updates);
//             a history, so a rollback or backup restore that brings an older
//             Talome ref back is still recognised as Talome's;
//   pinned  — the ref the user pinned per service (upgrade_app_image).
//
// Apps installed before this record existed have no history: their refs move
// as before when only the tag differs, and are kept when the repository
// differs (a fork or a different image is never a frozen install ref).

import yaml from "js-yaml";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { getSetting, setSetting } from "../utils/settings.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("image-refs");

export const IMAGE_REFS_SETTING_PREFIX = "app_image_refs:";
/** Refs remembered per service (oldest dropped first). */
const MANAGED_HISTORY_LIMIT = 20;

const ImageRefStateSchema = z.object({
  managed: z.record(z.string(), z.array(z.string())).default({}),
  pinned: z.record(z.string(), z.string()).default({}),
});

export type ImageRefState = z.infer<typeof ImageRefStateSchema>;

export type KeptImageReason = "pinned" | "customised" | "different_image";

export interface KeptImageRef {
  service: string;
  /** Ref the app keeps running */
  image: string;
  /** Ref the catalog has now */
  catalogImage: string;
  reason: KeptImageReason;
}

export type ImageRefDecision = { move: true } | { move: false; reason: KeptImageReason };

/** The app's record, or null when none was ever written (installed before it existed). */
export function readImageRefState(appId: string): ImageRefState | null {
  const raw = getSetting(`${IMAGE_REFS_SETTING_PREFIX}${appId}`);
  if (!raw) return null;
  try {
    const parsed = ImageRefStateSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function writeImageRefState(appId: string, state: ImageRefState): void {
  setSetting(`${IMAGE_REFS_SETTING_PREFIX}${appId}`, JSON.stringify(state));
}

/** `image:` of every service in a compose file ({} when unreadable). */
export function composeServiceImages(composePath: string): Record<string, string> {
  try {
    const doc = yaml.load(readFileSync(composePath, "utf-8")) as { services?: Record<string, { image?: unknown } | null> } | null;
    const images: Record<string, string> = {};
    for (const [service, svc] of Object.entries(doc?.services ?? {})) {
      if (typeof svc?.image === "string" && svc.image.trim()) images[service] = svc.image;
    }
    return images;
  } catch {
    return {};
  }
}

/** Start a fresh record for a new install: every ref in its compose is Talome's. */
export function resetImageRefState(appId: string, images: Record<string, string>): void {
  try {
    const managed: Record<string, string[]> = {};
    for (const [service, image] of Object.entries(images)) managed[service] = [image];
    writeImageRefState(appId, { managed, pinned: {} });
  } catch (err) {
    log.warn(`Could not record the image refs of ${appId}`, err);
  }
}

/** Remember refs Talome wrote (install/update). Never throws. */
export function recordManagedImages(appId: string, images: Record<string, string>): void {
  if (Object.keys(images).length === 0) return;
  try {
    const state = readImageRefState(appId) ?? { managed: {}, pinned: {} };
    for (const [service, image] of Object.entries(images)) {
      const history = (state.managed[service] ?? []).filter((ref) => ref !== image);
      history.push(image);
      state.managed[service] = history.slice(-MANAGED_HISTORY_LIMIT);
    }
    writeImageRefState(appId, state);
  } catch (err) {
    log.warn(`Could not record the image refs of ${appId}`, err);
  }
}

/** Remember that the user pinned `service` to `image`. Never throws. */
export function recordImagePin(appId: string, service: string, image: string): void {
  try {
    const state = readImageRefState(appId) ?? { managed: {}, pinned: {} };
    state.pinned[service] = image;
    writeImageRefState(appId, state);
  } catch (err) {
    log.warn(`Could not record the image pin of ${appId}/${service}`, err);
  }
}

/** Forget pins (the user moved these services to the catalog's images). Never throws. */
export function clearImagePins(appId: string, services: string[]): void {
  try {
    const state = readImageRefState(appId);
    if (!state || services.every((s) => !(s in state.pinned))) return;
    for (const service of services) delete state.pinned[service];
    writeImageRefState(appId, state);
  } catch (err) {
    log.warn(`Could not clear the image pins of ${appId}`, err);
  }
}

/** Repository of an image ref, without tag/digest and the implicit Docker Hub prefix. */
export function imageRepository(ref: string): string {
  let repo = ref.trim().split("@")[0];
  const lastSlash = repo.lastIndexOf("/");
  const lastColon = repo.lastIndexOf(":");
  if (lastColon > lastSlash) repo = repo.slice(0, lastColon);
  repo = repo.replace(/^(docker\.io|index\.docker\.io|registry-1\.docker\.io)\//, "");
  return repo.replace(/^library\//, "");
}

/**
 * Whether an update may move `service` from `from` (override) to `to`
 * (catalog). `adoptCatalog`: the user asked for the catalog's images.
 */
export function decideImageRef(
  state: ImageRefState | null,
  service: string,
  from: string,
  to: string,
  opts: { adoptCatalog?: boolean } = {},
): ImageRefDecision {
  if (opts.adoptCatalog) return { move: true };
  // A pin counts while the compose still runs the pinned ref (a rollback may have undone it).
  if (state?.pinned[service] === from) return { move: false, reason: "pinned" };
  const history = state?.managed[service];
  if (history && history.length > 0) {
    return history.includes(from) ? { move: true } : { move: false, reason: "customised" };
  }
  // No history (installed before it was recorded): only tag drift is Talome's.
  return imageRepository(from) === imageRepository(to) ? { move: true } : { move: false, reason: "different_image" };
}

/** One sentence describing kept refs for notifications and results ("" when none). */
export function describeKeptImages(kept: KeptImageRef[]): string {
  if (kept.length === 0) return "";
  const why: Record<KeptImageReason, string> = {
    pinned: "pinned",
    customised: "customised",
    different_image: "a different image than the catalog's",
  };
  const list = kept.map((k) => `${k.service} stays on ${k.image} (${why[k.reason]}; the catalog has ${k.catalogImage})`).join("; ");
  return `Kept your image choice${kept.length > 1 ? "s" : ""}: ${list}. Update with useCatalogImages to switch to the catalog's images.`;
}
