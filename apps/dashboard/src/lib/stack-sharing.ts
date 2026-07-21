export interface StackCapsuleResponse {
  capsuleCode: string;
  fingerprint: string;
  qrEligible: boolean;
  maxQrPayloadLength: number;
  publicLinkEligible: boolean;
  recipeFileCode: string;
  recipeFileName: string;
  recoveryFileCode: string;
  recoveryFileName: string;
  hasCustomApps: boolean;
  recommendedTransport: "recovery-file" | "qr-or-code" | "code-or-file";
  /** Backward-compatible full recovery aliases. */
  fileCode: string;
  fileName: string;
  linkCompatible: boolean;
  capsuleLength: number;
  maxLinkLength: number;
  missingCatalogApps: Array<{ appId: string; name: string }>;
}

export function buildPublicCapsuleUrl(capsuleCode: string): string | null {
  const configured = process.env.NEXT_PUBLIC_TALOME_SHARE_URL?.trim();
  if (!configured) return null;
  const withoutHash = configured.split("#", 1)[0];
  const base = withoutHash.endsWith("/") ? withoutHash : `${withoutHash}/`;
  return `${base}#${capsuleCode}`;
}

export function downloadStackFile(fileCode: string, fileName: string): void {
  const blob = new Blob([fileCode], { type: "application/vnd.talome.stack;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

export async function shareStackFile(fileCode: string, fileName: string, title: string): Promise<"shared" | "downloaded"> {
  const file = new File([fileCode], fileName, { type: "application/vnd.talome.stack" });
  const shareData = { title, text: "Open this stack file in Talome.", files: [file] };

  if (navigator.share && navigator.canShare) {
    try {
      if (navigator.canShare(shareData)) {
        await navigator.share(shareData);
        return "shared";
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") throw error;
      // Unsupported file sharing falls through to a normal download.
    }
  }

  downloadStackFile(fileCode, fileName);
  return "downloaded";
}

export function codeFromStackFile(contents: string): string {
  return contents.trim();
}
