"use client";

import { useState, useCallback } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Button } from "@/components/ui/button";
import {
  HugeiconsIcon,
  LayoutAlignLeftIcon,
  DashboardCircleIcon,
  ArrowLeft01Icon,
  Add01Icon,
  Tick01Icon,
  DashboardSquare02Icon,
  BubbleChatDownload02Icon,
  Share04Icon,
} from "@/components/icons";
import { IconSwap } from "@/components/ui/micro";
import { useAtomValue } from "jotai";
import { useAssistant } from "@/components/assistant/assistant-context";
import { useWidgetEdit } from "@/components/widgets/widget-edit-context";
import { useWidgetLayout } from "@/hooks/use-widget-layout";
import { useAutomation } from "@/components/automations/automation-context";
import { pageTitleAtom } from "@/atoms/page-title";
import { pageActionAtom } from "@/atoms/page-action";
import { pageBackAtom } from "@/atoms/page-back";
import { AnimatePresence, motion } from "motion/react";
import { toast } from "sonner";
import { MobileNav } from "@/components/layout/mobile-nav";
import { requestDesktopNavigation } from "@/lib/desktop-navigation";
import { useContainerLookup } from "@/hooks/use-containers";
import { DURATION, EASE_ENTER, EASE_EXIT, enter } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { humanizeSlug, navTitleForPath } from "./nav-config";
import { SETTINGS_CATEGORIES } from "@/components/settings/settings-nav";

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
      // Legacy deep links that aren't listed in the menu.
      networking: "Networking",
      backups: "Backups",
      // Visible sections share the menu's names, including AI Agents and Audit Log.
      ...Object.fromEntries(SETTINGS_CATEGORIES.flatMap((category) =>
        category.items.map((item) => [item.slug, item.title]))),
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

/** Header title (P1-3): 12px travel, 160ms in on the enter curve, 120ms out. */
const TITLE_TRAVEL = 12;
const titleSlideVariants = {
  enter: (dir: number) => ({
    opacity: 0,
    x: dir === 0 ? 0 : dir > 0 ? TITLE_TRAVEL : -TITLE_TRAVEL,
  }),
  center: {
    opacity: 1,
    x: 0,
    // Opacity finishes at 60% of the travel (motion.enter).
    transition: enter(DURATION.pill),
  },
  exit: (dir: number) => ({
    opacity: 0,
    x: dir === 0 ? 0 : dir > 0 ? -TITLE_TRAVEL : TITLE_TRAVEL,
    transition: { duration: DURATION.exitFast, ease: EASE_EXIT },
  }),
};
/** Back button width change: 140ms. */
const BACK_BUTTON_TRANSITION = { duration: DURATION.exit, ease: EASE_ENTER } as const;

function AutomationsHeaderAction() {
  const { openCreate } = useAutomation();
  return (
    <div className="ml-auto shrink-0">
      <Button
        variant="ghost"
        size="sm"
        className="h-7 gap-1.5 px-2.5 text-xs text-muted-foreground hover:text-foreground phone-touch:h-11 phone-touch:px-3"
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
  const { resetLayout, restoreLayout } = useWidgetLayout({ remoteSync: false });

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
        className="size-7 text-muted-foreground hover:text-foreground transition-colors phone-touch:size-11"
        asChild
      >
        <Link href="/dashboard/share" aria-label="Share setup">
          <HugeiconsIcon icon={Share04Icon} size={16} />
        </Link>
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="size-7 text-muted-foreground hover:text-foreground transition-colors phone-touch:size-11"
        onClick={() => setEditMode((v) => !v)}
        aria-label={editMode ? "Done editing" : "Edit widgets"}
      >
        <IconSwap
          active={editMode ? "b" : "a"}
          a={<HugeiconsIcon icon={DashboardSquare02Icon} size={16} />}
          b={<HugeiconsIcon icon={Tick01Icon} size={16} />}
        />
      </Button>
    </div>
  );
}

function ServicesHeaderAction() {
  const { handleSubmit } = useAssistant();
  const router = useRouter();
  // Names are only needed to build the prompt — shared, non-polling lookup.
  const { containers } = useContainerLookup();

  const running = containers.filter((c) => c.status === "running");

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
    if (!requestDesktopNavigation("/dashboard/assistant")) {
      router.push("/dashboard/assistant");
    }
  };

  return (
    <div className="ml-auto shrink-0">
      <Button
        variant="ghost"
        size="sm"
        className="h-7 gap-1.5 px-2.5 text-xs text-muted-foreground hover:text-foreground phone-touch:h-11 phone-touch:px-3"
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
  // Titles come from nav-config, so the header never shows a raw slug.
  const label = navTitleForPath(pathname);
  const isAssistant = currentPage === "assistant";
  const isHome = currentPage === "dashboard";
  const isAutomations = currentPage === "automations";
  const isApps = currentPage === "apps";
  const isContainers = currentPage === "containers";

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

  // Track drilldown direction for header animation. Adjusted during render
  // (React's "store previous props in state" pattern) so the first committed
  // frame already carries the right direction.
  const [drilldownNav, setDrilldownNav] = useState({ isSub: false, slug: null as string | null, dir: 0 });
  if (activeDrilldown && (isDrilldownSub !== drilldownNav.isSub || drilldownSlug !== drilldownNav.slug)) {
    const dir = isDrilldownSub !== drilldownNav.isSub
      ? (isDrilldownSub ? 1 : -1)
      : isDrilldownSub ? 0 : drilldownNav.dir; // section switch — crossfade
    setDrilldownNav({ isSub: isDrilldownSub, slug: drilldownSlug, dir });
  }
  const drilldownDir = drilldownNav.dir;

  const inConversation = messages.length > 0 || activeId !== null;
  const title = activeId ? conversations.find((c) => c.id === activeId)?.title : undefined;
  const dynamicTitle = useAtomValue(pageTitleAtom);
  const pageAction = useAtomValue(pageActionAtom);
  const pageBack = useAtomValue(pageBackAtom);

  // Atom-based drilldown: any page can set pageTitleAtom + pageBackAtom
  // to get the same animated back-button + title as URL-based drilldowns.
  const hasAtomDrilldown = !activeDrilldown && !isAssistant && !!pageBack;
  const [atomNav, setAtomNav] = useState({ active: false, title: null as string | null, dir: 0 });
  if (hasAtomDrilldown !== atomNav.active || dynamicTitle !== atomNav.title) {
    const dir = hasAtomDrilldown !== atomNav.active
      ? (hasAtomDrilldown ? 1 : -1)
      : hasAtomDrilldown ? 0 : atomNav.dir;
    setAtomNav({ active: hasAtomDrilldown, title: dynamicTitle, dir });
  }
  const atomDrilldownDir = atomNav.dir;

  return (
    // Nothing scrolls under the header, so it has no backdrop blur to pay for.
    <header className="flex h-12 shrink-0 items-center gap-1.5 bg-background px-4">
      {/* Desktop: standard sidebar toggle */}
      <div className="hidden md:flex">
        <SidebarTrigger className="size-8 shrink-0 text-muted-foreground hover:text-foreground transition-colors phone-touch:size-11">
          <HugeiconsIcon icon={LayoutAlignLeftIcon} size={20} strokeWidth={1.5} />
        </SidebarTrigger>
      </div>

      {/* Mobile: floating panel trigger */}
      <div className="flex md:hidden">
        <Button
          variant="ghost"
          size="icon"
          className="size-8 shrink-0 text-muted-foreground hover:text-foreground transition-colors phone-touch:size-11"
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
          className="size-7 shrink-0 text-muted-foreground hover:text-foreground transition-colors -ml-1 phone-touch:size-11"
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
            transition={BACK_BUTTON_TRANSITION}
            className={cn("overflow-hidden shrink-0", isDrilldownSub && "phone-touch:min-w-11")}
          >
            {activeDrilldown.useHistoryBack ? (
              <Button
                variant="ghost"
                size="icon"
                className="size-7 text-muted-foreground hover:text-foreground transition-colors phone-touch:size-11"
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
                className="size-7 text-muted-foreground hover:text-foreground transition-colors phone-touch:size-11"
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
            <AnimatePresence initial={false} custom={drilldownDir}>
              <motion.span
                key={drilldownSlug ?? "root"}
                custom={drilldownDir}
                variants={titleSlideVariants}
                initial="enter"
                animate="center"
                exit="exit"
                className={`text-sm font-medium truncate ${isDrilldownSub ? "text-muted-foreground" : ""}`}
              >
                {isDrilldownSub
                  ? ((activeDrilldown.rootPrefix === "/dashboard/settings" ? activeDrilldown.titles?.[drilldownSlug!] : undefined)
                      ?? dynamicTitle
                      ?? activeDrilldown.titles?.[drilldownSlug!]
                      ?? humanizeSlug(drilldownSlug!))
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
            transition={BACK_BUTTON_TRANSITION}
            className="overflow-hidden shrink-0 phone-touch:min-w-11"
          >
            <Button
              variant="ghost"
              size="icon"
              className="size-7 text-muted-foreground hover:text-foreground transition-colors phone-touch:size-11"
              onClick={pageBack}
              aria-label="Go back"
            >
              <HugeiconsIcon icon={ArrowLeft01Icon} size={14} />
            </Button>
          </motion.div>
          <div className="grid [&>*]:col-start-1 [&>*]:row-start-1 items-center min-w-0 overflow-hidden">
            <AnimatePresence initial={false} custom={atomDrilldownDir}>
              <motion.span
                key={dynamicTitle ?? "root"}
                custom={atomDrilldownDir}
                variants={titleSlideVariants}
                initial="enter"
                animate="center"
                exit="exit"
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
            className="h-7 gap-1.5 px-2.5 text-xs text-muted-foreground hover:text-foreground phone-touch:h-11 phone-touch:px-3"
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
            className="h-7 gap-1.5 px-2.5 text-xs text-muted-foreground hover:text-foreground phone-touch:h-11 phone-touch:px-3"
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
    </header>
  );
}
