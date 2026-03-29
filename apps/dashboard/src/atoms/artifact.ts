import { atom } from "jotai";
import type { BlueprintState } from "@/components/creator/blueprint-draft-bar";

/** Accumulated blueprint state from design_app_blueprint tool calls. */
export const blueprintAtom = atom<BlueprintState>({});
