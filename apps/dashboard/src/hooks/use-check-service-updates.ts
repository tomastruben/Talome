"use client";

import { useCallback, useMemo } from "react";
import { useRouter } from "next/navigation";
import useSWR from "swr";
import type { Container } from "@talome/types";
import { useAssistant } from "@/components/assistant/assistant-context";
import { CORE_URL } from "@/lib/constants";

export function useCheckServiceUpdates() {
  const { handleSubmit } = useAssistant();
  const router = useRouter();
  const { data: containers } = useSWR<Container[]>(
    `${CORE_URL}/api/containers`,
    (url: string) => fetch(url, { credentials: "include" }).then((response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.json();
    }),
  );

  const running = useMemo(
    () => (containers ?? []).filter((container) => container.status === "running"),
    [containers],
  );

  return useCallback(() => {
    const previewNames = running.slice(0, 12).map((container) => container.name);
    const more = running.length > previewNames.length
      ? ` (+${running.length - previewNames.length} more)`
      : "";
    const runningList = previewNames.length > 0
      ? `${previewNames.join(", ")}${more}`
      : "none detected";

    const prompt = [
      "Context:",
      "- Scope: all running containers",
      `- Running containers count: ${running.length}`,
      `- Running containers: ${runningList}`,
      "",
      "Task:",
      "Check for available updates across all running containers.",
      "Use relevant Talome tools first (for example list_containers, list_apps, get_app_config, and read_app_config_file where needed).",
      "Group results by service with current image/tag, update availability, and safest next step. Ask for confirmation before any modifying action.",
    ].join("\n");

    void handleSubmit(prompt, "Current page: /dashboard/containers");
    router.push("/dashboard/assistant");
  }, [handleSubmit, router, running]);
}
