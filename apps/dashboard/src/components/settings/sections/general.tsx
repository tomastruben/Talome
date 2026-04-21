"use client";

import { useState, useEffect } from "react";
import { useTheme } from "next-themes";
import useSWR from "swr";
import { CORE_URL } from "@/lib/constants";
import { SettingsGroup, ToggleRow, InfoRow } from "@/components/settings/settings-primitives";

const fetcher = (url: string) => fetch(url).then((r) => r.json());

export function GeneralSection() {
  const [mounted, setMounted] = useState(false);
  const { theme, setTheme } = useTheme();
  const { data: system } = useSWR<{ dockerSocket?: string }>(
    `${CORE_URL}/api/system`,
    fetcher,
    { revalidateOnFocus: false },
  );

  useEffect(() => { setMounted(true); }, []);

  return (
    <div className="grid gap-6">
      <p className="text-sm text-muted-foreground leading-relaxed">
        Appearance and system-level configuration for Talome.
      </p>

      <SettingsGroup>
        {mounted && (
          <ToggleRow
            label="Dark Mode"
            hint="Use dark theme throughout"
            checked={theme === "dark"}
            onCheckedChange={(checked) => setTheme(checked ? "dark" : "light")}
          />
        )}
        <InfoRow label="Docker Socket" value={system?.dockerSocket ?? "detecting…"} />
      </SettingsGroup>

      <p className="text-xs text-muted-foreground px-1">
        Override the Docker socket with the <code className="font-mono">DOCKER_SOCKET</code> environment variable.
      </p>
    </div>
  );
}
