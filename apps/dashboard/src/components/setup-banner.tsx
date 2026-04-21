"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { useSetupStatus } from "@/hooks/use-setup-status";

const TOAST_AI = "setup-ai-warning";
const TOAST_BUILDING = "setup-building";

export function SetupBanner() {
  const { isLoaded, isConfigured, phase, nearestStack } = useSetupStatus();
  const router = useRouter();
  const aiShownRef = useRef(false);
  const buildingShownRef = useRef(false);

  useEffect(() => {
    if (!isLoaded) return;

    // AI provider not configured — persistent toast
    if (!isConfigured && !aiShownRef.current) {
      aiShownRef.current = true;
      toast.warning("AI provider not configured", {
        id: TOAST_AI,
        description: "Set up a key to use the Assistant.",
        duration: Infinity,
        action: {
          label: "Configure",
          onClick: () => router.push("/dashboard/settings/ai-provider"),
        },
      });
    } else if (isConfigured) {
      toast.dismiss(TOAST_AI);
    }

    // Building phase — soft toast with stack progress (auto-dismiss)
    if (phase === "building" && nearestStack && !buildingShownRef.current) {
      buildingShownRef.current = true;
      const pct = Math.round(nearestStack.readiness * 100);
      toast.info(`${nearestStack.name} is ${pct}% set up`, {
        id: TOAST_BUILDING,
        description: "Visit your dashboard to continue setup.",
        duration: 10000,
        action: {
          label: "Continue",
          onClick: () => router.push(nearestStack.dashboardPage),
        },
      });
    } else if (phase !== "building") {
      toast.dismiss(TOAST_BUILDING);
    }
  }, [isLoaded, isConfigured, phase, nearestStack, router]);

  return null;
}
