"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import useSWR from "swr";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Button } from "@/components/ui/button";
import {
  HugeiconsIcon,
  LayoutAlignLeftIcon,
  LayoutGridIcon,
  DashboardCircleIcon,
  ArrowLeft01Icon,
  Add01Icon,
  Tick01Icon,
  DashboardSquare02Icon,
  SourceCodeCircleIcon,
  BubbleChatDownload02Icon,
  Share04Icon,
  Wifi01Icon,
} from "@/components/icons";
import { useAtom, useAtomValue } from "jotai";
import { useAssistant } from "@/components/assistant/assistant-context";
import { useWidgetEdit } from "@/components/widgets/widget-edit-context";
import { useWidgetLayout } from "@/hooks/use-widget-layout";
import { useAutomation } from "@/components/automations/automation-context";
import { launchClaudeCodeAtom, terminalAutoAtom, terminalRemoteAtom, terminalRemoteActiveAtom } from "@/atoms/terminal";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { pageTitleAtom } from "@/atoms/page-title";
import { pageActionAtom } from "@/atoms/page-action";
import { pageBackAtom } from "@/atoms/page-back";
import { AnimatePresence, motion } from "framer-motion";
import { toast } from "sonner";
import { MobileNav } from "@/components/layout/mobile-nav";
import { CORE_URL } from "@/lib/constants";
import type { Container } from "@talome/types";

const pathLabels: Record<string, string> = {
  dashboard: "Home",
  media: "Media",
  containers: "Services",
  apps: "App Store",
  storage: "Storage",
  assistant: "Assistant",
  settings: "Settings",
  terminal: "Terminal",
  files: "Files",
  audiobooks: "Audiobooks",
  automations: "Automations",
  intelligence: "Intelligence",
  "bug-hunt": "Bug Hunt",
  share: "Share",
};

interface DrilldownRoute {
  rootPrefix: string;
  rootTitle: string;
  backHref: string;
  minSegments: number;
  slugIndex: number;
  titles?: Record<string, string>;
  /** Use browser history back instead of backHref — preserves deep navigation context */
  useHistoryBack?: boolean;
}

const DRILLDOWN_ROUTES: DrilldownRoute[] = [
  {
    rootPrefix: "/dashboard/settings",
    rootTitle: "Settings",
    backHref: "/dashboard/settings",
    minSegments: 3,
    slugIndex: 2,
    useHistoryBack: true,
    titles: {
      users: "Users & Access",
      "ai-provider": "AI Provider",
      "ai-tools": "AI Tools",
      "ai-prompt": "System Prompt",
      "ai-memory": "Memory",
      connections: "Media Services",
      integrations: "Chat Bots",
      mcp: "MCP Server",
      "app-sources": "App Sources",
      "community-review": "Community Review",
      stacks: "Export & Import",
      networking: "Networking",
      backups: "Backups",
      intelligence: "Intelligence",
      "ai-cost": "API Cost",
      "file-manager": "File Manager",
      "media-player": "Media Player",
    },
  },
  {
    rootPrefix: "/dashboard/apps",
    rootTitle: "App Store",
    backHref: "/dashboard/apps",
    minSegments: 4,
    slugIndex: 3,
    useHistoryBack: true,
  },
  {
    rootPrefix: "/dashboard/share",
    rootTitle: "Share",
    backHref: "/dashboard",
    minSegments: 2,
    slugIndex: 1,
    titles: { share: "Share" },
  },
];

const titleSlideVariants = {
  enter: (dir: number) => ({
    opacity: 0,
    x: dir === 0 ? 0 : dir > 0 ? 20 : -20,
  }),
  center: {
    opacity: 1,
    x: 0,
  },
  exit: (dir: number) => ({
    opacity: 0,
    x: dir === 0 ? 0 : dir > 0 ? -20 : 20,
  }),
};

function AutomationsHeaderAction() {
  const { openCreate } = useAutomation();
  return (
    <div className="ml-auto shrink-0">
      <Button
        variant="ghost"
        size="sm"
        className="h-7 gap-1.5 px-2.5 text-xs text-muted-foreground hover:text-foreground"
        onClick={openCreate}
      >
        <HugeiconsIcon icon={Add01Icon} size={14} />
        New
      </Button>
    </div>
  );
}

function HomeEditControls() {
  const { editMode, setEditMode } = useWidgetEdit();
  const { resetLayout, restoreLayout } = useWidgetLayout();

  const handleReset = useCallback(() => {
    const prev = resetLayout();
    toast("Layout reset to default", {
      action: {
        label: "Undo",
        onClick: () => restoreLayout(prev),
      },
    });
  }, [resetLayout, restoreLayout]);

  return (
    <div className="ml-auto flex items-center gap-1 shrink-0">
      <AnimatePresence mode="popLayout">
        {editMode && (
          <motion.div
            key="reset"
            initial={{ opacity: 0, x: 6 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 6 }}
            transition={{ duration: 0.15 }}
          >
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2.5 text-xs text-muted-foreground hover:text-foreground"
              onClick={handleReset}
            >
              Reset
            </Button>
          </motion.div>
        )}
      </AnimatePresence>
      <Button
        variant="ghost"
        size="icon"
        className="size-7 text-dim-foreground hover:text-foreground transition-colors"
        asChild
      >
        <Link href="/dashboard/share" aria-label="Share setup">
          <HugeiconsIcon icon={Share04Icon} size={16} />
        </Link>
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="size-7 text-dim-foreground hover:text-foreground transition-colors"
        onClick={() => setEditMode((v) => !v)}
        aria-label={editMode ? "Done editing" : "Edit widgets"}
      >
        <HugeiconsIcon icon={editMode ? Tick01Icon : DashboardSquare02Icon} size={16} />
      </Button>
    </div>
  );
}

function TerminalHeaderAction() {
  const launchClaudeCode = useAtomValue(launchClaudeCodeAtom);
  const [autoMode, setAutoMode] = useAtom(terminalAutoAtom);
  const [remote, setRemote] = useAtom(terminalRemoteAtom);
  const remoteActive = useAtomValue(terminalRemoteActiveAtom);

  // Sync from localStorage after hydration
  useEffect(() => {
    setAutoMode(localStorage.getItem("talome-auto-mode") === "true");
    setRemote(localStorage.getItem("talome-remote-mode") === "true");
  }, [setAutoMode, setRemote]);

  return (
    <div className="ml-auto shrink-0">
      <div className={cn(
        "flex items-center h-7 rounded-md transition-colors",
        autoMode ? "bg-status-warning/10 ring-1 ring-status-warning/20" : "bg-muted/30 ring-1 ring-border/50"
      )}>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              className="flex items-center gap-1.5 h-7 px-2 rounded-l-md transition-colors hover:bg-white/5"
              onClick={() => {
                const next = !autoMode;
                setAutoMode(next);
                localStorage.setItem("talome-auto-mode", String(next));
              }}
            >
              <span className={cn(
                "relative inline-flex h-3.5 w-6 shrink-0 items-center rounded-full transition-colors",
                autoMode ? "bg-status-warning" : "bg-input"
              )}>
                <span className={cn(
                  "inline-block size-2.5 rounded-full bg-white transition-transform",
                  autoMode ? "translate-x-3" : "translate-x-0.5"
                )} />
              </span>
              <span className={cn(
                "text-xs font-medium transition-colors",
                autoMode ? "text-status-warning" : "text-muted-foreground"
              )}>
                Auto
              </span>
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="text-xs">
            {autoMode ? "Skip permission prompts" : "Require permission prompts"}
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              className={cn(
                "relative flex items-center justify-center size-7 transition-colors hover:bg-white/5",
                remote
                  ? autoMode ? "text-status-warning" : "text-foreground"
                  : "text-muted-foreground/50"
              )}
              onClick={() => {
                const next = !remote;
                setRemote(next);
                localStorage.setItem("talome-remote-mode", String(next));
              }}
            >
              <HugeiconsIcon icon={Wifi01Icon} size={13} />
              {remoteActive && (
                <span className="absolute top-1 right-1 size-1.5 rounded-full bg-status-healthy" />
              )}
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="text-xs">
            {remoteActive ? "Remote session active" : remote ? "Remote — next launch includes --remote-control" : "Enable remote access"}
          </TooltipContent>
        </Tooltip>
        <Button
          variant="ghost"
          size="sm"
          className={cn(
            "h-7 gap-1.5 px-2.5 text-xs rounded-l-none",
            autoMode
              ? "text-status-warning/80 hover:text-status-warning hover:bg-status-warning/10"
              : "text-muted-foreground hover:text-foreground"
          )}
          onClick={() => launchClaudeCode?.()}
          disabled={!launchClaudeCode}
        >
          <HugeiconsIcon icon={SourceCodeCircleIcon} size={14} />
          Claude Code
        </Button>
      </div>
    </div>
  );
}

function ServicesHeaderAction() {
  const { handleSubmit } = useAssistant();
  const router = useRouter();
  const { data: containers } = useSWR<Container[]>(
    `${CORE_URL}/api/containers`,
    (url: string) => fetch(url, { credentials: "include" }).then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    })
  );

  const running = (containers ?? []).filter((c) => c.status === "running");

  const checkAllUpdates = () => {
    const previewNames = running.slice(0, 12).map((c) => c.name);
    const more = running.length > previewNames.length ? ` (+${running.length - previewNames.length} more)` : "";
    const runningList = previewNames.length > 0 ? `${previewNames.join(", ")}${more}` : "none detected";

    const prompt = [
      "Context:",
      `- Scope: all running containers`,
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
  };

  return (
    <div className="ml-auto shrink-0">
      <Button
        variant="ghost"
        size="sm"
        className="h-7 gap-1.5 px-2.5 text-xs text-muted-foreground hover:text-foreground"
        onClick={checkAllUpdates}
      >
        <HugeiconsIcon icon={BubbleChatDownload02Icon} size={14} />
        Check updates
      </Button>
    </div>
  );
}

export function SiteHeader() {
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const closeMobileNav = useCallback(() => setMobileNavOpen(false), []);
  const pathname = usePathname();
  const router = useRouter();
  const { messages, conversations, activeId, startNew } = useAssistant();

  const segments = pathname.split("/").filter(Boolean);
  const currentPage = segments[segments.length - 1] || "dashboard";
  const label = pathLabels[currentPage] ?? currentPage;
  const isAssistant = currentPage === "assistant";
  const isHome = currentPage === "dashboard";
  const isAutomations = currentPage === "automations";
  const isApps = currentPage === "apps";
  const isContainers = currentPage === "containers";
  const isTerminal = currentPage === "terminal";

  // Generic drilldown detection
  const activeDrilldown = DRILLDOWN_ROUTES.find(
    (r) => pathname === r.rootPrefix || pathname.startsWith(r.rootPrefix + "/")
  );
  const isDrilldownSub = activeDrilldown
    ? segments.length >= activeDrilldown.minSegments
    : false;
  const drilldownSlug = activeDrilldown && isDrilldownSub
    ? segments[activeDrilldown.slugIndex]
    : null;

  // Track drilldown direction for header animation
  const prevDrilldownState = useRef({ isSub: false, slug: null as string | null });
  const drilldownDir = useRef(0);
  if (activeDrilldown) {
    const prev = prevDrilldownState.current;
    if (isDrilldownSub !== prev.isSub) {
      drilldownDir.current = isDrilldownSub ? 1 : -1;
    } else if (isDrilldownSub && drilldownSlug !== prev.slug) {
      drilldownDir.current = 0; // section switch — crossfade
    }
    prevDrilldownState.current = { isSub: isDrilldownSub, slug: drilldownSlug };
  }

  const inConversation = messages.length > 0 || activeId !== null;
  const title = activeId ? conversations.find((c) => c.id === activeId)?.title : undefined;
  const dynamicTitle = useAtomValue(pageTitleAtom);
  const pageAction = useAtomValue(pageActionAtom);
  const pageBack = useAtomValue(pageBackAtom);

  // Atom-based drilldown: any page can set pageTitleAtom + pageBackAtom
  // to get the same animated back-button + title as URL-based drilldowns.
  const hasAtomDrilldown = !activeDrilldown && !isAssistant && !!pageBack;
  const prevAtomDrilldown = useRef({ active: false, title: null as string | null });
  const atomDrilldownDir = useRef(0);
  if (hasAtomDrilldown !== prevAtomDrilldown.current.active) {
    atomDrilldownDir.current = hasAtomDrilldown ? 1 : -1;
  } else if (hasAtomDrilldown && dynamicTitle !== prevAtomDrilldown.current.title) {
    atomDrilldownDir.current = 0;
  }
  prevAtomDrilldown.current = { active: hasAtomDrilldown, title: dynamicTitle };

  return (
    <header className="flex h-12 shrink-0 items-center gap-1.5 bg-background/75 px-4 backdrop-blur-sm">
      {/* Desktop: standard sidebar toggle */}
      <div className="hidden md:flex">
        <SidebarTrigger className="size-8 shrink-0 text-muted-foreground hover:text-foreground transition-colors">
          <HugeiconsIcon icon={LayoutAlignLeftIcon} size={20} strokeWidth={1.5} />
        </SidebarTrigger>
      </div>

      {/* Mobile: floating panel trigger */}
      <div className="flex md:hidden">
        <Button
          variant="ghost"
          size="icon"
          className="size-8 shrink-0 text-muted-foreground hover:text-foreground transition-colors"
          onClick={() => setMobileNavOpen(true)}
          aria-label="Open navigation"
        >
          <HugeiconsIcon icon={DashboardCircleIcon} size={18} strokeWidth={1.5} />
        </Button>
        <MobileNav open={mobileNavOpen} onClose={closeMobileNav} />
      </div>

      {/* Assistant back button */}
      {isAssistant && inConversation && (
        <Button
          variant="ghost"
          size="icon"
          className="size-7 shrink-0 text-dim-foreground hover:text-foreground transition-colors -ml-1"
          onClick={startNew}
          aria-label="Back to conversations"
        >
          <HugeiconsIcon icon={ArrowLeft01Icon} size={14} />
        </Button>
      )}

      {/* Drilldown back button + animated title (Settings, App Store, etc.) */}
      {activeDrilldown ? (
        <div className="flex items-center min-w-0">
          <motion.div
            initial={false}
            animate={{
              width: isDrilldownSub ? 28 : 0,
              opacity: isDrilldownSub ? 1 : 0,
              marginLeft: isDrilldownSub ? -4 : 0,
              marginRight: isDrilldownSub ? 6 : 0,
            }}
            transition={{ duration: 0.35, ease: [0.32, 0.72, 0, 1] }}
            className="overflow-hidden shrink-0"
          >
            {activeDrilldown.useHistoryBack ? (
              <Button
                variant="ghost"
                size="icon"
                className="size-7 text-dim-foreground hover:text-foreground transition-colors"
                onClick={() => router.back()}
                tabIndex={isDrilldownSub ? 0 : -1}
                aria-label="Go back"
              >
                <HugeiconsIcon icon={ArrowLeft01Icon} size={14} />
              </Button>
            ) : (
              <Button
                variant="ghost"
                size="icon"
                className="size-7 text-dim-foreground hover:text-foreground transition-colors"
                asChild
                tabIndex={isDrilldownSub ? 0 : -1}
              >
                <Link href={activeDrilldown.backHref} aria-label={`Back to ${activeDrilldown.rootTitle}`}>
                  <HugeiconsIcon icon={ArrowLeft01Icon} size={14} />
                </Link>
              </Button>
            )}
          </motion.div>
          <div className="grid [&>*]:col-start-1 [&>*]:row-start-1 items-center min-w-0 overflow-hidden">
            <AnimatePresence initial={false} custom={drilldownDir.current}>
              <motion.span
                key={drilldownSlug ?? "root"}
                custom={drilldownDir.current}
                variants={titleSlideVariants}
                initial="enter"
                animate="center"
                exit="exit"
                transition={{ duration: 0.35, ease: [0.32, 0.72, 0, 1] }}
                className={`text-sm font-medium truncate ${isDrilldownSub ? "text-muted-foreground" : ""}`}
              >
                {isDrilldownSub
                  ? (activeDrilldown.titles?.[drilldownSlug!]
                      ?? dynamicTitle
                      ?? drilldownSlug!.split("-").map((w: string) => w.charAt(0).toUpperCase() + w.slice(1)).join(" "))
                  : activeDrilldown.rootTitle}
              </motion.span>
            </AnimatePresence>
          </div>
        </div>
      ) : hasAtomDrilldown ? (
        <div className="flex items-center min-w-0">
          <motion.div
            initial={false}
            animate={{
              width: 28,
              opacity: 1,
              marginLeft: -4,
              marginRight: 6,
            }}
            transition={{ duration: 0.35, ease: [0.32, 0.72, 0, 1] }}
            className="overflow-hidden shrink-0"
          >
            <Button
              variant="ghost"
              size="icon"
              className="size-7 text-dim-foreground hover:text-foreground transition-colors"
              onClick={pageBack}
              aria-label="Go back"
            >
              <HugeiconsIcon icon={ArrowLeft01Icon} size={14} />
            </Button>
          </motion.div>
          <div className="grid [&>*]:col-start-1 [&>*]:row-start-1 items-center min-w-0 overflow-hidden">
            <AnimatePresence initial={false} custom={atomDrilldownDir.current}>
              <motion.span
                key={dynamicTitle ?? "root"}
                custom={atomDrilldownDir.current}
                variants={titleSlideVariants}
                initial="enter"
                animate="center"
                exit="exit"
                transition={{ duration: 0.35, ease: [0.32, 0.72, 0, 1] }}
                className="text-sm font-medium truncate text-muted-foreground"
              >
                {dynamicTitle ?? label}
              </motion.span>
            </AnimatePresence>
          </div>
        </div>
      ) : (
        <span className={`text-sm font-medium truncate ${isAssistant && inConversation && title ? "text-muted-foreground" : ""}`}>
          {isAssistant && inConversation && title ? title : (dynamicTitle ?? label)}
        </span>
      )}

      {isAssistant && inConversation && (
        <div className="ml-auto shrink-0">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1.5 px-2.5 text-xs text-muted-foreground hover:text-foreground"
            onClick={startNew}
          >
            <HugeiconsIcon icon={Add01Icon} size={14} />
            New
          </Button>
        </div>
      )}

      {pageAction}
      {isHome && <HomeEditControls />}
      {isAutomations && <AutomationsHeaderAction />}
      {isApps && (
        <div className="ml-auto shrink-0">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1.5 px-2.5 text-xs text-muted-foreground hover:text-foreground"
            asChild
          >
            <Link href="/dashboard/assistant?prompt=I+want+to+create+a+new+app">
              <HugeiconsIcon icon={Add01Icon} size={14} />
              Create
            </Link>
          </Button>
        </div>
      )}
      {isContainers && <ServicesHeaderAction />}
      {isTerminal && <TerminalHeaderAction />}
    </header>
  );
}
