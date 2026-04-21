import type { StoreAdapter } from "./types.js";
import type { StoreType } from "@talome/types";
import { talomeAdapter } from "./talome-adapter.js";
import { casaosAdapter } from "./casaos-adapter.js";
import { umbrelAdapter } from "./umbrel-adapter.js";

export type { StoreAdapter } from "./types.js";

const adapters: StoreAdapter[] = [talomeAdapter, casaosAdapter, umbrelAdapter];

export function detectStoreType(storePath: string): StoreType | null {
  for (const adapter of adapters) {
    if (adapter.detect(storePath)) return adapter.type;
  }
  return null;
}

export function getAdapter(type: StoreType): StoreAdapter | null {
  if (type === "user-created") return talomeAdapter;
  return adapters.find((a) => a.type === type) || null;
}

export { talomeAdapter, casaosAdapter, umbrelAdapter };
