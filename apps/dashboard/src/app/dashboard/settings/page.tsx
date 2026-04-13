"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTheme } from "next-themes";
import useSWR from "swr";
import {
  HugeiconsIcon,
  ArrowRight01Icon,
  UserIcon,
  AiCloudIcon,
  AiMagicIcon,
  ToolsIcon,
  QuillWrite01Icon,
  AiBrain01Icon,
  PlayIcon,
  ChatBotIcon,
  Plug02Icon,
  Layers01Icon,
  PackageAdd01Icon,
  CheckmarkBadge01Icon,
  Globe02Icon,
  ArchiveIcon,
  Logout01Icon,
  ChartIcon,
  HardDriveIcon,
  FileVideoIcon,
  Shield01Icon,
  AlertCircleIcon,
  SystemUpdate01Icon,
  CpuIcon,
  LayoutGridIcon,
  ComputerTerminal01Icon,
} from "@/components/icons";
import { useUser } from "@/hooks/use-user";
import { CORE_URL } from "@/lib/constants";
import { SettingsGroup, ToggleRow, InfoRow } from "@/components/settings/settings-primitives";
import type { IconSvgElement } from "@/components/icons";

interface SettingsLink {
  slug: string;
  icon: IconSvgElement;
  title: string;
  description: string;
  adminOnly?: boolean;
}

const GENERAL_ITEMS: SettingsLink[] = [
  { slug: "users", icon: UserIcon, title: "Users & Access", description: "Create members, manage roles", adminOnly: true },
];

const AI_ITEMS: SettingsLink[] = [
  { slug: "ai-provider", icon: AiCloudIcon, title: "AI Provider", description: "Anthropic, OpenAI, and Ollama keys" },
  { slug: "intelligence", icon: AiMagicIcon, title: "Intelligence", description: "Agent loop, auto-remediation, self-improvement", adminOnly: true },
  { slug: "ai-cost", icon: ChartIcon, title: "API Cost", description: "Track spend, set daily caps, view usage breakdown" },
  { slug: "ai-tools", icon: ToolsIcon, title: "AI Tools", description: "Manage built-in and custom tools" },
  { slug: "ai-prompt", icon: QuillWrite01Icon, title: "System Prompt", description: "Customise the assistant's personality" },
  { slug: "ai-memory", icon: AiBrain01Icon, title: "Memory", description: "What the assistant remembers about you" },
];

const INFRASTRUCTURE_ITEMS: SettingsLink[] = [
  { slug: "security", icon: Shield01Icon, title: "Security", description: "Control AI access level and shell permissions", adminOnly: true },
  { slug: "notifications", icon: AlertCircleIcon, title: "Notifications", description: "Alert thresholds and notification channels" },
  { slug: "networking", icon: Globe02Icon, title: "Networking", description: "Reverse proxy, remote access, Docker networks", adminOnly: true },
  { slug: "backups", icon: ArchiveIcon, title: "Backups", description: "Scheduled backups and restore history" },
  { slug: "file-manager", icon: HardDriveIcon, title: "File Manager", description: "Control which external drives are accessible", adminOnly: true },
  { slug: "media-player", icon: FileVideoIcon, title: "Media Player", description: "HLS transcode cache and playback settings" },
  { slug: "updates", icon: SystemUpdate01Icon, title: "App Updates", description: "Available updates and auto-update policies", adminOnly: true },
];

const CONNECTIONS_ITEMS: SettingsLink[] = [
  { slug: "connections", icon: PlayIcon, title: "Media Services", description: "Sonarr, Radarr, Prowlarr, qBittorrent, Overseerr" },
  { slug: "integrations", icon: ChatBotIcon, title: "Chat Bots", description: "Telegram and Discord" },
];

const DEVELOPER_ITEMS: SettingsLink[] = [
  { slug: "mcp", icon: Plug02Icon, title: "MCP Server", description: "Connect Cursor, Claude Desktop, or Claude Code" },
  { slug: "app-sources", icon: PackageAdd01Icon, title: "App Sources", description: "Manage app store sources" },
  { slug: "community-review", icon: CheckmarkBadge01Icon, title: "Community Review", description: "Review and approve submitted apps", adminOnly: true },
  { slug: "stacks", icon: Layers01Icon, title: "Export & Import", description: "Share settings and app stack codes" },
];

const LEGAL_ITEMS: SettingsLink[] = [
  { slug: "legal", icon: Shield01Icon, title: "Legal & Disclaimer", description: "User responsibility, content policies, compliance" },
];

function CategoryLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground px-1 mb-2">
      {children}
    </p>
  );
}

function SettingsLinkRow({ item }: { item: SettingsLink }) {
  return (
    <Link href={`/dashboard/settings/${item.slug}`} className="block">
      <div className="px-4 py-3.5 flex items-center gap-3 hover:bg-muted/30 transition-colors cursor-pointer">
        <div className="size-8 rounded-lg bg-muted/50 flex items-center justify-center shrink-0">
          <HugeiconsIcon icon={item.icon} size={16} className="text-muted-foreground" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium">{item.title}</p>
          <p className="text-xs text-muted-foreground mt-0.5">{item.description}</p>
        </div>
        <HugeiconsIcon icon={ArrowRight01Icon} size={14} className="text-dim-foreground shrink-0" />
      </div>
    </Link>
  );
}

function SettingsCategory({ label, items, isAdmin }: { label: string; items: SettingsLink[]; isAdmin: boolean }) {
  const visible = items.filter((item) => !item.adminOnly || isAdmin);
  if (visible.length === 0) return null;

  return (
    <section>
      <CategoryLabel>{label}</CategoryLabel>
      <div className="rounded-xl border border-border bg-card divide-y divide-border overflow-hidden">
        {visible.map((item) => (
          <SettingsLinkRow key={item.slug} item={item} />
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
        <p className="text-sm font-medium">Server Mode</p>
        {switching && (
          <span className="text-xs text-muted-foreground animate-pulse">
            {currentMode === "dev" ? "Building and restarting…" : "Switching to dev…"}
          </span>
        )}
      </div>
      {!managed && (
        <p className="text-xs text-muted-foreground mb-2">
          Start with <span className="font-mono text-[11px]">pnpm start</span> to enable mode switching.
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
                <span className="absolute top-2.5 right-2.5 size-3 rounded-full border-[1.5px] border-muted-foreground/40 border-t-muted-foreground animate-spin" />
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

function GeneralInline() {
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
            label="Dark Mode"
            hint="Use dark theme throughout"
            checked={theme === "dark"}
            onCheckedChange={(checked) => setTheme(checked ? "dark" : "light")}
          />
        )}
        <ServerModeToggle />
        <InfoRow label="Docker Socket" value={system?.dockerSocket ?? "detecting…"} />
      </SettingsGroup>
    </section>
  );
}

function ServicesSection() {
  const { data: state, mutate } = useSWR<{
    processes: Record<string, { pid: number | null; status: string }>;
  }>(`${CORE_URL}/api/supervisor/status`, fetcher, { refreshInterval: 10000, revalidateOnFocus: false });

  const [restarting, setRestarting] = useState<string | null>(null);

  const restart = async (service?: string) => {
    const key = service ?? "all";
    setRestarting(key);
    try {
      await fetch(`${CORE_URL}/api/supervisor/restart`, {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ service }),
      });
      // Wait for restart, then refresh
      setTimeout(() => { setRestarting(null); void mutate(); }, service === "core" ? 8000 : 3000);
    } catch {
      setRestarting(null);
    }
  };

  const services: Array<{ key: string; label: string; desc: string; icon: IconSvgElement }> = [
    { key: "core", label: "Core", desc: "API, AI agent, Docker, media", icon: CpuIcon },
    { key: "dashboard", label: "Dashboard", desc: "Web interface", icon: LayoutGridIcon },
    { key: "terminal_daemon", label: "Terminal", desc: "Shell sessions, Claude Code", icon: ComputerTerminal01Icon },
  ];

  if (!state?.processes) return null;

  return (
    <section>
      <CategoryLabel>Services</CategoryLabel>
      <div className="rounded-xl border border-border bg-card divide-y divide-border overflow-hidden">
        {services.map((s) => {
          const proc = state.processes[s.key];
          // Dashboard always shows as "up" since we're rendering this page on it
          const isUp = s.key === "dashboard" || proc?.status === "healthy" || proc?.status === "starting";
          const isRestarting = restarting === s.key || restarting === "all";
          return (
            <div key={s.key} className="px-4 py-3.5 flex items-center gap-3">
              <div className={`size-8 rounded-lg flex items-center justify-center shrink-0 ${isUp ? "bg-status-healthy/10" : "bg-status-critical/10"}`}>
                <HugeiconsIcon
                  icon={s.icon}
                  size={16}
                  className={isRestarting ? "text-status-warning animate-pulse" : isUp ? "text-status-healthy" : "text-status-critical"}
                />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium">{s.label}</p>
                <p className="text-xs text-muted-foreground">{s.desc}</p>
              </div>
              <button
                disabled={isRestarting}
                onClick={() => void restart(s.key)}
                className="text-xs text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
              >
                {isRestarting ? "Restarting…" : "Restart"}
              </button>
            </div>
          );
        })}
        <div className="px-4 py-2.5 flex justify-end">
          <button
            disabled={restarting !== null}
            onClick={() => void restart()}
            className="text-xs text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
          >
            {restarting === "all" ? "Restarting all…" : "Restart all services"}
          </button>
        </div>
      </div>
    </section>
  );
}

function LogoutButton() {
  const router = useRouter();

  const handleLogout = async () => {
    await fetch(`${CORE_URL}/api/auth/logout`, {
      method: "POST",
      credentials: "include",
    });
    router.push("/");
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

  return (
    <div className="mx-auto w-full max-w-2xl min-w-0 grid gap-8 pb-12">
      <GeneralInline />
      <ServicesSection />
      <SettingsCategory label="Access" items={GENERAL_ITEMS} isAdmin={isAdmin} />
      <SettingsCategory label="AI" items={AI_ITEMS} isAdmin={isAdmin} />
      <SettingsCategory label="Infrastructure" items={INFRASTRUCTURE_ITEMS} isAdmin={isAdmin} />
      <SettingsCategory label="Connections" items={CONNECTIONS_ITEMS} isAdmin={isAdmin} />
      <SettingsCategory label="Developer" items={DEVELOPER_ITEMS} isAdmin={isAdmin} />
      <SettingsCategory label="Legal" items={LEGAL_ITEMS} isAdmin={isAdmin} />
      <LogoutButton />
      <p className="text-center text-xs text-muted-foreground/30 pt-2">
        Designed and built by Tomas Truben &middot; AGPL-3.0
      </p>
    </div>
  );
}
