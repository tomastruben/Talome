"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTheme } from "next-themes";
import useSWR from "swr";
import {
  HugeiconsIcon,
  ArrowRight01Icon,
  Logout01Icon,
} from "@/components/icons";
import { useUser } from "@/hooks/use-user";
import { CORE_URL } from "@/lib/constants";
import { SettingsGroup, ToggleRow, InfoRow } from "@/components/settings/settings-primitives";
import { usePendingApprovals } from "@/components/trust/api";
import { Spinner } from "@/components/ui/spinner";
import { ServicesSection } from "@/components/system/services-section";
import { logOut } from "@/lib/session";
import { toast } from "sonner";
import { SETTINGS_CATEGORIES, type SettingsLink } from "@/components/settings/settings-nav";
import { WaitingBadge } from "@/components/settings/settings-sidebar";
import { useSettingsLayout } from "@/components/settings/settings-layout-context";

function CategoryLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-xs font-medium text-muted-foreground px-1 mb-2">
      {children}
    </p>
  );
}

function SettingsLinkRow({ item, badge }: { item: SettingsLink; badge?: number }) {
  return (
    <Link
      href={`/dashboard/settings/${item.slug}`}
      data-desktop-navigation="bypass"
      className="block"
    >
      <div className="px-4 py-3.5 flex items-center gap-3 hover:bg-muted/30 transition-colors cursor-pointer">
        <div className="size-8 rounded-lg bg-muted/50 flex items-center justify-center shrink-0">
          <HugeiconsIcon icon={item.icon} size={16} className="text-muted-foreground" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium">{item.title}</p>
          <p className="text-xs text-muted-foreground mt-0.5">{item.description}</p>
        </div>
        {badge !== undefined && badge > 0 && <WaitingBadge count={badge} />}
        <HugeiconsIcon icon={ArrowRight01Icon} size={14} className="text-dim-foreground shrink-0" />
      </div>
    </Link>
  );
}

function SettingsCategory({
  label,
  items,
  isAdmin,
  badges,
}: {
  label: string;
  items: SettingsLink[];
  isAdmin: boolean;
  badges?: Record<string, number>;
}) {
  const visible = items.filter((item) => !item.adminOnly || isAdmin);
  if (visible.length === 0) return null;

  return (
    <section>
      <CategoryLabel>{label}</CategoryLabel>
      <div className="rounded-xl border border-border bg-card divide-y divide-border overflow-hidden">
        {visible.map((item) => (
          <SettingsLinkRow key={item.slug} item={item} badge={badges?.[item.slug]} />
        ))}
      </div>
    </section>
  );
}

const fetcher = (url: string) => fetch(url).then((r) => r.json());

function ServerModeToggle() {
  const { data: modeData, mutate: mutateMode } = useSWR<{ mode: string; active: string; managed: boolean }>(
    `${CORE_URL}/api/supervisor/mode`, fetcher, { revalidateOnFocus: false },
  );
  const [switching, setSwitching] = useState(false);
  const currentMode = modeData?.active ?? modeData?.mode ?? "build";
  const managed = modeData?.managed ?? false;

  const doSwitch = async (mode: "dev" | "build") => {
    if (mode === currentMode || switching || !managed) return;
    setSwitching(true);
    try {
      await fetch(`${CORE_URL}/api/supervisor/mode`, {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode }),
      });
      // Poll until the new mode is active
      const poll = setInterval(() => {
        fetch(`${CORE_URL}/api/supervisor/mode`, { credentials: "include" })
          .then((r) => r.json())
          .then((d: { active?: string }) => {
            if (d.active === mode) {
              clearInterval(poll);
              void mutateMode();
              setSwitching(false);
            }
          })
          .catch(() => { /* core still restarting */ });
      }, 2000);
      setTimeout(() => { clearInterval(poll); setSwitching(false); void mutateMode(); }, 60_000);
    } catch { setSwitching(false); }
  };

  const modes = [
    { key: "dev" as const, label: "Dev", desc: "Source files watched, changes apply on save. Uses more memory." },
    { key: "build" as const, label: "Build", desc: "Compiled for speed. Self-improvement changes trigger a rebuild." },
  ];

  return (
    <div className="px-4 py-3.5">
      <div className="flex items-center gap-2 mb-3">
        <p className="text-sm font-medium">Server mode</p>
        {switching && (
          <span className="text-xs text-muted-foreground motion-safe:animate-pulse">
            {currentMode === "dev" ? "Building and restarting…" : "Switching to dev…"}
          </span>
        )}
      </div>
      {!managed && (
        <p className="text-xs text-muted-foreground mb-2">
          Start with <span className="font-mono">pnpm start</span> to enable mode switching.
        </p>
      )}
      <div className="grid grid-cols-2 gap-2">
        {modes.map((m) => {
          const active = currentMode === m.key;
          return (
            <button
              key={m.key}
              disabled={switching || !managed}
              onClick={() => void doSwitch(m.key)}
              className={`relative rounded-lg px-3.5 py-3 text-left transition-all ${
                active
                  ? "bg-foreground/[0.08] ring-1 ring-foreground/20"
                  : "bg-muted/30 hover:bg-muted/50"
              } disabled:opacity-60`}
            >
              {active && switching && (
                <Spinner label="Switching mode" className="absolute top-2.5 right-2.5 size-3.5 text-muted-foreground" />
              )}
              <p className={`text-sm font-medium ${active ? "text-foreground" : "text-muted-foreground"}`}>{m.label}</p>
              <p className="text-xs text-muted-foreground mt-0.5">{m.desc}</p>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function GeneralInline({ isAdmin }: { isAdmin: boolean }) {
  const [mounted, setMounted] = useState(false);
  const { theme, setTheme } = useTheme();
  const { data: system } = useSWR<{ dockerSocket?: string }>(
    `${CORE_URL}/api/system`, fetcher, { revalidateOnFocus: false },
  );
  useEffect(() => { setMounted(true); }, []);

  return (
    <section>
      <CategoryLabel>General</CategoryLabel>
      <SettingsGroup>
        {mounted && (
          <ToggleRow
            label="Dark mode"
            hint="Use dark theme throughout"
            checked={theme === "dark"}
            onCheckedChange={(checked) => setTheme(checked ? "dark" : "light")}
          />
        )}
        {/* Switching the server mode restarts it: administration, like Services below. */}
        {isAdmin ? <ServerModeToggle /> : null}
        <InfoRow label="Docker socket" value={system?.dockerSocket ?? "detecting…"} />
      </SettingsGroup>
    </section>
  );
}

function LogoutButton() {
  const router = useRouter();

  // Navigate only once the server ended the session (D-P0-6); otherwise say so, with Retry.
  const handleLogout = async () => {
    const result = await logOut();
    if (result.ok) {
      router.push("/");
      return;
    }
    toast.error(result.error, { action: { label: "Retry", onClick: () => void handleLogout() } });
  };

  return (
    <section>
      <div className="rounded-xl border border-border bg-card overflow-hidden">
        <button
          onClick={handleLogout}
          className="w-full px-4 py-3.5 flex items-center gap-3 hover:bg-muted/30 transition-colors cursor-pointer"
        >
          <div className="size-8 rounded-lg bg-muted/50 flex items-center justify-center shrink-0">
            <HugeiconsIcon icon={Logout01Icon} size={16} className="text-muted-foreground" />
          </div>
          <p className="text-sm font-medium">Log out</p>
        </button>
      </div>
    </section>
  );
}

export default function SettingsPage() {
  const { isAdmin } = useUser();
  const { count: pendingApprovals } = usePendingApprovals(isAdmin);
  const { twoPane } = useSettingsLayout();

  return (
    <div className="mx-auto w-full max-w-2xl min-w-0 grid gap-8 pb-12">
      <GeneralInline isAdmin={isAdmin} />
      {/* Restarting core, the dashboard or the terminal (every shell and Claude Code session) is admin-only. */}
      {isAdmin ? <ServicesSection heading={<CategoryLabel>Services</CategoryLabel>} /> : null}
      {/* In two-pane mode the sidebar lists the sections; this pane is "General" */}
      {!twoPane && SETTINGS_CATEGORIES.map((category) => (
        <SettingsCategory
          key={category.label}
          label={category.label}
          items={category.items}
          isAdmin={isAdmin}
          badges={{ approvals: pendingApprovals }}
        />
      ))}
      <LogoutButton />
      <p className="text-center text-xs text-muted-foreground pt-2">
        Designed and built by Tomas Truben &middot; AGPL-3.0
      </p>
    </div>
  );
}
