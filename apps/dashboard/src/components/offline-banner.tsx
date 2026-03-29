"use client";

import { useEffect, useRef, useCallback } from "react";
import { toast } from "sonner";
import { useIsOnline } from "@/hooks/use-is-online";
import { useAssistant } from "@/components/assistant/assistant-context";

const OFFLINE_TOAST_ID = "offline-banner";
const DEGRADED_TOAST_ID = "degraded-banner";

export function OfflineBanner() {
  const { status, checks } = useIsOnline();
  const prevStatusRef = useRef<typeof status>("online");
  const { handleSubmit, openPaletteInChatMode } = useAssistant();

  const askAboutDegraded = useCallback(() => {
    const failedChecks = Object.entries(checks)
      .filter(([, v]) => v === "error")
      .map(([k]) => k)
      .join(", ");
    handleSubmit(
      `The Talome server is degraded${failedChecks ? ` — the following checks are failing: ${failedChecks}` : ""}. ` +
      "Can you diagnose what's wrong and suggest how to fix it?"
    );
    openPaletteInChatMode();
  }, [handleSubmit, openPaletteInChatMode, checks]);

  useEffect(() => {
    const prev = prevStatusRef.current;
    prevStatusRef.current = status;

    if (status === "offline") {
      toast.dismiss(DEGRADED_TOAST_ID);
      // Server is completely unreachable — no point offering "Ask Talome"
      // since the AI API is on the same server and would also fail.
      toast.error("Talome server is unreachable", {
        id: OFFLINE_TOAST_ID,
        description: "Check that the server is running. Retrying...",
        duration: Infinity,
        cancel: {
          label: "Dismiss",
          onClick: () => toast.dismiss(OFFLINE_TOAST_ID),
        },
      });
    } else if (status === "degraded") {
      toast.dismiss(OFFLINE_TOAST_ID);
      // Server is up but a subsystem (Docker/DB) is failing — AI can still
      // help diagnose since the API is reachable.
      toast.warning("Some services unavailable", {
        id: DEGRADED_TOAST_ID,
        description: "Docker or database may be down.",
        duration: Infinity,
        action: {
          label: "Ask Talome",
          onClick: askAboutDegraded,
        },
        cancel: {
          label: "Dismiss",
          onClick: () => toast.dismiss(DEGRADED_TOAST_ID),
        },
      });
    } else {
      // Back online — dismiss any error banners and confirm recovery
      const wasDown = prev === "offline" || prev === "degraded";
      toast.dismiss(OFFLINE_TOAST_ID);
      toast.dismiss(DEGRADED_TOAST_ID);
      if (wasDown) {
        toast.success("Talome server reconnected");
      }
    }
  }, [status, askAboutDegraded]);

  return null;
}
