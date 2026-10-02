/**
 * Turn a getUserMedia failure into a message that says what actually went
 * wrong. Every failure used to read "Microphone access was denied", even when
 * there was no microphone at all (a Mac mini has none built in) or the
 * browser blocked it without ever asking.
 */
export async function microphoneErrorMessage(error: unknown): Promise<string> {
  const name = error instanceof DOMException || error instanceof Error ? error.name : "";

  if (name === "NotFoundError" || name === "OverconstrainedError" || name === "DevicesNotFoundError") {
    return "No microphone found. Connect one, then try again.";
  }
  if (name === "NotReadableError" || name === "TrackStartError" || name === "AbortError") {
    return "The microphone is busy or unavailable. Close other apps using it, then try again.";
  }
  if (name === "NotAllowedError" || name === "SecurityError" || name === "PermissionDeniedError") {
    // Blocked: by the person (the site's permission is "denied"), or without a
    // prompt by the system or the browser (permission still "prompt").
    let state: PermissionState | null = null;
    try {
      const status = await navigator.permissions?.query({ name: "microphone" as PermissionName });
      state = status?.state ?? null;
    } catch {
      // Some browsers can't query the microphone permission
    }
    if (state === "denied") {
      return "Microphone access is blocked for this site. Allow it in the browser's site settings, then try again.";
    }
    return "The microphone was blocked without asking. Allow it for this browser in your system's privacy settings, then try again.";
  }
  return "Couldn't start the microphone. Try again.";
}
