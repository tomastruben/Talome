export interface VoiceEnvironment {
  origin: string;
  secure: boolean;
  embedded: boolean;
  capture: boolean;
  recorder: boolean;
  recognition: boolean;
  policy: boolean | null;
  permission: PermissionState | "unknown";
}

/** Read-only checks: never request capture or enumerate device identities. */
export async function readVoiceEnvironment(): Promise<VoiceEnvironment> {
  const page = document as Document & {
    permissionsPolicy?: { allowsFeature: (name: string) => boolean };
    featurePolicy?: { allowsFeature: (name: string) => boolean };
  };
  const browser = window as Window & { SpeechRecognition?: unknown; webkitSpeechRecognition?: unknown };
  let permission: VoiceEnvironment["permission"] = "unknown";
  try {
    permission = (await navigator.permissions.query({ name: "microphone" as PermissionName })).state;
  } catch { /* Safari and embedded browsers may not expose this query. */ }
  let policy: boolean | null = null;
  try { policy = (page.permissionsPolicy ?? page.featurePolicy)?.allowsFeature("microphone") ?? null; } catch { /* Not inspectable here. */ }
  return {
    origin: window.location.origin, secure: window.isSecureContext,
    embedded: window.self !== window.top, capture: !!navigator.mediaDevices?.getUserMedia,
    recorder: typeof MediaRecorder !== "undefined",
    recognition: !!(browser.SpeechRecognition ?? browser.webkitSpeechRecognition), policy, permission,
  };
}

export function microphonePromptExplanation(env: VoiceEnvironment): string {
  if (!env.secure) return "This page is not a secure context. Microphone capture cannot start or show a permission prompt. Use HTTPS or localhost.";
  if (env.policy === false) return "The page or iframe permissions policy blocks the microphone before a prompt can appear. Compare with Open outside desktop.";
  if (!env.capture) return "This browser does not expose microphone capture here. An embedded browser host may disable it; compare in Safari or Chrome.";
  if (env.permission === "denied") return "The browser reports microphone access as denied. A site setting, page policy, or browser restriction can prevent another prompt. Check site and system permissions.";
  if (env.permission === "granted") return "Permission is already granted, so another prompt is not expected. Test microphone checks whether audio capture can actually start.";
  return "Permission is prompt or unknown. Test microphone requests capture directly from your click. The browser decides whether to show a prompt; this page cannot reset a saved denial or inspect system permissions.";
}
