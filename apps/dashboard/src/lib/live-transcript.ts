export interface LiveTranscriptEntry {
  id: number;
  role: "user" | "assistant";
  text: string;
  startMs: number | null;
  endMs: number | null;
}

/** Speakers can overlap. Delivery delays must not split an utterance. */
export function appendLiveTranscript(
  entries: LiveTranscriptEntry[],
  role: LiveTranscriptEntry["role"],
  delta: string,
  startMs: number | null,
  endMs: number | null,
): LiveTranscriptEntry[] {
  if (!delta) return entries;
  const index = entries.findLastIndex((entry) => entry.role === role);
  const previous = entries[index];
  const continuous = previous && (startMs === null || previous.endMs === null || startMs - previous.endMs < 1500);
  if (continuous) {
    return entries.map((entry, i) => i === index
      ? { ...entry, text: entry.text + delta, endMs: endMs ?? entry.endMs }
      : entry);
  }
  return [...entries, { id: (entries.at(-1)?.id ?? 0) + 1, role, text: delta, startMs, endMs }];
}
