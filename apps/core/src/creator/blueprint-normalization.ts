import { AppBlueprintSchema } from "./contracts.js";

/** One observed, meaning-preserving repair; never repair data, references, or currency values. */
export function repairCreatorBlueprint(text: string): { text: string; removedPaths: string[] } | null {
  let value;
  try { value = JSON.parse(text); } catch { return null; }
  const removedPaths: string[] = [];
  if (!Array.isArray(value?.appSpec?.surfaces)) return null;
  value.appSpec.surfaces.forEach((surface: { blocks?: unknown[] }, surfaceIndex: number) => {
    if (!Array.isArray(surface?.blocks)) return;
    surface.blocks.forEach((unknownBlock, blockIndex) => {
      const block = unknownBlock as { component?: string; columns?: unknown[] } | null;
      if (block?.component !== "table" || !Array.isArray(block.columns)) return;
      block.columns.forEach((unknownColumn, columnIndex) => {
        const column = unknownColumn as { currency?: string; format?: string } | null;
        if (column && column.currency === "" && column.format !== "currency") {
          delete column.currency;
          removedPaths.push(`appSpec.surfaces.${surfaceIndex}.blocks.${blockIndex}.columns.${columnIndex}.currency`);
        }
      });
    });
  });
  // Any remaining invalid field fails normally; normalization is never a fallback blueprint.
  if (!removedPaths.length || !AppBlueprintSchema.safeParse(value).success) return null;
  return { text: JSON.stringify(value), removedPaths };
}
