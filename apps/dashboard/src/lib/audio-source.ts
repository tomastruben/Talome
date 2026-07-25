export const AUDIO_ATTEMPT_PARAM = "talome_audio_attempt";

/**
 * Give each intentional media load its own URL. WebKit can otherwise reuse a
 * failed partial response for the same media URL, leaving the element in an
 * unrecoverable decode state even though a fresh Range request is healthy.
 */
export function createAudioAttemptUrl(
  source: string,
  baseUrl: string,
  attempt: string,
): string {
  const url = new URL(source, baseUrl);
  url.searchParams.set(AUDIO_ATTEMPT_PARAM, attempt);
  return url.href;
}

export function normalizeAudioSource(source: string, baseUrl: string): string {
  return new URL(source, baseUrl).href;
}

export function isAudioSourceCurrent(
  currentSource: string,
  expectedSource: string,
  baseUrl: string,
): boolean {
  if (!currentSource || !expectedSource) return false;
  return normalizeAudioSource(currentSource, baseUrl) === normalizeAudioSource(expectedSource, baseUrl);
}
