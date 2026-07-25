const AUDIO_CONTENT_TYPES: Record<string, string> = {
  aac: "audio/aac",
  flac: "audio/flac",
  m4a: "audio/mp4",
  m4b: "audio/mp4",
  mp3: "audio/mpeg",
  mp4: "audio/mp4",
  oga: "audio/ogg",
  ogg: "audio/ogg",
  opus: "audio/ogg",
  wav: "audio/wav",
  weba: "audio/webm",
};

export function resolveAudioContentType(
  upstreamContentType: string | null,
  filename?: string | null,
): string {
  const normalized = upstreamContentType?.split(";", 1)[0]?.trim().toLowerCase();
  if (normalized?.startsWith("audio/")) return upstreamContentType!;

  const extension = filename?.split(".").pop()?.toLowerCase();
  if (extension && AUDIO_CONTENT_TYPES[extension]) return AUDIO_CONTENT_TYPES[extension];

  return normalized || "application/octet-stream";
}
