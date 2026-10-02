/**
 * Turn a getUserMedia failure into a message that says what actually went
 * wrong. Every failure used to read "Microphone access was denied", even when
 * there was no microphone at all (a Mac mini has none built in) or the
 * browser blocked it without ever asking.
 */
export async function microphoneErrorMessage(error: unknown): Promise<string> {
  const name = error instanceof DOMException || error instanceof Error ? error.name : "";

  if (typeof window !== "undefined" && window.isSecureContext === false) {
    return "Voice needs a secure connection. Open Talome over HTTPS or on localhost.";
  }
  const policy = typeof document === "undefined" ? undefined : (document as Document & {
    permissionsPolicy?: { allowsFeature: (feature: string) => boolean };
    featurePolicy?: { allowsFeature: (feature: string) => boolean };
  });
  if ((policy?.permissionsPolicy ?? policy?.featurePolicy)?.allowsFeature("microphone") === false) {
    return "This page's permissions policy blocks the microphone. Open Talome directly in a browser; changing your system microphone permission won't fix this page policy.";
  }
  if (name === "TypeError" && !navigator.mediaDevices?.getUserMedia) {
    return "This browser doesn't support microphone capture here. Open Talome in Safari or Chrome.";
  }

  if (name === "NotFoundError" || name === "OverconstrainedError" || name === "DevicesNotFoundError") {
    return "No microphone found. Connect one, then try again.";
  }
  if (name === "NotReadableError" || name === "TrackStartError" || name === "AbortError") {
    return "The microphone is busy or unavailable. Close other apps using it, then try again.";
  }
  if (name === "NotAllowedError" || name === "SecurityError" || name === "PermissionDeniedError") {
    // Permission state alone cannot distinguish a user decision from a
    // browser/host restriction. A granted permission can still fail capture.
    let state: PermissionState | null = null;
    try {
      const status = await navigator.permissions?.query({ name: "microphone" as PermissionName });
      state = status?.state ?? null;
    } catch {
      // Some browsers can't query the microphone permission
    }
    if (state === "denied") {
      return "Microphone access is blocked for this site or browser. Check the site's microphone setting and your system's microphone permission for this browser, then try again.";
    }
    if (state === "granted") {
      return "Microphone permission is granted, but this browser couldn't start audio capture. Try again. If you're using an in-app browser, open Talome in Safari or Chrome.";
    }
    return "This browser couldn't access the microphone. Check the site's microphone setting and your system's permission for this browser. If you're using an in-app browser, try Safari or Chrome.";
  }
  return "Couldn't start the microphone. Try again.";
}
