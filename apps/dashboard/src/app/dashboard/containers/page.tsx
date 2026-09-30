"use client";

import { useCallback, useEffect, useState, useMemo } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  Table,
  TableBody,
  TableCell,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger, TabsBadge, TabsDot } from "@/components/ui/tabs";
import { Skeleton } from "@/components/ui/skeleton";
import { SearchField } from "@/components/ui/search-field";
import { EmptyState, ErrorState } from "@/components/ui/empty-state";
import { ServiceStackList } from "@/components/dashboard/service-stack-list";
import { useServiceStacks } from "@/hooks/use-service-stacks";
import {
  CloudServerIcon,
  Layers01Icon,
  Package01Icon,
  PlayIcon,
  StopIcon,
} from "@/components/icons";
import {
  SourceList,
  SourceListItem,
  SourceListSection,
  WINDOW_SIDEBAR_REPLACES,
  WindowSidebarLayout,
} from "@/components/ui/source-list";
import { useAssistant } from "@/components/assistant/assistant-context";
import { Button } from "@/components/ui/button";
import { requestDesktopNavigation } from "@/lib/desktop-navigation";

// ── Types ─────────────────────────────────────────────────────────────────────

type StatusFilter = "all" | "running" | "stopped";
type SourceFilter = "all" | "managed" | "external";

// ── Skeleton ──────────────────────────────────────────────────────────────────

function StackRowSkeleton() {
  return (
    <TableRow>
      <TableCell className="w-11 pl-3 pr-0">
        <Skeleton className="size-9 rounded-lg" />
      </TableCell>
      <TableCell>
        <div className="grid gap-1.5">
          <Skeleton className="h-4 w-28" />
          <Skeleton className="h-3 w-40" />
        </div>
      </TableCell>
      <TableCell className="hidden sm:table-cell"><Skeleton className="h-3 w-12" /></TableCell>
      <TableCell className="hidden sm:table-cell"><Skeleton className="h-3 w-10 ml-auto" /></TableCell>
      <TableCell><Skeleton className="h-3 w-12 ml-auto" /></TableCell>
      <TableCell><Skeleton className="h-7 w-7 rounded-md ml-auto" /></TableCell>
    </TableRow>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function ContainersPage() {
  const [search, setSearch]             = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>("all");
  const { stacks, isLoading, error, refresh } = useServiceStacks();
  const { handleSubmit, openPaletteInChatMode } = useAssistant();
  const router = useRouter();

  useEffect(() => {
    const query = new URLSearchParams(window.location.search).get("q")?.trim();
    if (!query) return;
    const frame = window.requestAnimationFrame(() => setSearch(query));
    return () => window.cancelAnimationFrame(frame);
  }, []);

  const runningCount = stacks.filter((s) => s.status === "running").length;
  const stoppedCount = stacks.filter((s) => s.status === "stopped").length;
  const isManaged = useCallback((s: (typeof stacks)[number]) =>
    s.kind === "talome" || s.primaryContainer.labels["talome.managed"] === "true", []);
  const managedCount = stacks.filter(isManaged).length;
  const externalCount = stacks.filter((s) => !isManaged(s)).length;
  const hasExternal = externalCount > 0;

  const filtered = useMemo(() => {
    return stacks.filter((s) => {
      const q = search.toLowerCase();
      const matchesSearch =
        !search ||
        s.name.toLowerCase().includes(q) ||
        s.containers.some(
          (c) => c.name.toLowerCase().includes(q) || c.image.toLowerCase().includes(q),
        );
      const matchesStatus =
        statusFilter === "all" ||
        (statusFilter === "running" && s.status === "running") ||
        (statusFilter === "stopped" && s.status === "stopped");
      const matchesSource =
        sourceFilter === "all" ||
        (sourceFilter === "managed" && isManaged(s)) ||
        (sourceFilter === "external" && !isManaged(s));
      return matchesSearch && matchesStatus && matchesSource;
    });
  }, [stacks, search, statusFilter, sourceFilter, isManaged]);

  // In a desktop window the two filter groups become sidebar sections
  const count = (n: number) => (!isLoading && n > 0 ? n : undefined);
  const sidebar = (
    <SourceList label="Services sidebar">
      <SourceListSection title="Status">
        <SourceListItem icon={Layers01Icon} label="All Services" active={statusFilter === "all"} trailing={count(stacks.length)} onSelect={() => setStatusFilter("all")} />
        <SourceListItem icon={PlayIcon} iconClassName="text-status-healthy" label="Running" active={statusFilter === "running"} trailing={count(runningCount)} onSelect={() => setStatusFilter("running")} />
        <SourceListItem icon={StopIcon} iconClassName="text-status-critical" label="Stopped" active={statusFilter === "stopped"} trailing={count(stoppedCount)} onSelect={() => setStatusFilter("stopped")} />
      </SourceListSection>
      {!isLoading && hasExternal && (
        <SourceListSection title="Source">
          <SourceListItem icon={Layers01Icon} label="Everywhere" active={sourceFilter === "all"} onSelect={() => setSourceFilter("all")} />
          <SourceListItem icon={Package01Icon} label="Managed by Talome" active={sourceFilter === "managed"} trailing={count(managedCount)} onSelect={() => setSourceFilter("managed")} />
          <SourceListItem icon={CloudServerIcon} label="External" active={sourceFilter === "external"} trailing={count(externalCount)} onSelect={() => setSourceFilter("external")} />
        </SourceListSection>
      )}
    </SourceList>
  );

  return (
    <WindowSidebarLayout sidebar={sidebar}>
    <div className="grid gap-5">
      {/* Controls */}
      <div className="page-controls-row flex-wrap gap-2">
        <Tabs
          className={WINDOW_SIDEBAR_REPLACES}
          value={statusFilter}
          onValueChange={(v) => setStatusFilter(v as StatusFilter)}
        >
          <TabsList>
            <TabsTrigger value="all" className="text-xs">
              All
              {!isLoading && stacks.length > 0 && (
                <TabsBadge>{stacks.length}</TabsBadge>
              )}
            </TabsTrigger>
            <TabsTrigger value="running" className="text-xs gap-1.5">
              <TabsDot color="emerald" />
              <span className="hidden sm:inline">Running</span>
              {!isLoading && runningCount > 0 && (
                <TabsBadge>{runningCount}</TabsBadge>
              )}
            </TabsTrigger>
            <TabsTrigger value="stopped" className="text-xs gap-1.5">
              <TabsDot color="red" />
              <span className="hidden sm:inline">Stopped</span>
              {!isLoading && stoppedCount > 0 && (
                <TabsBadge>{stoppedCount}</TabsBadge>
              )}
            </TabsTrigger>
          </TabsList>
        </Tabs>

        {/* Source filter — only visible when external containers exist */}
        {!isLoading && hasExternal && (
          <Tabs
            className={WINDOW_SIDEBAR_REPLACES}
            value={sourceFilter}
            onValueChange={(v) => setSourceFilter(v as SourceFilter)}
          >
            <TabsList>
              <TabsTrigger value="all" className="text-xs">
                All
              </TabsTrigger>
              <TabsTrigger value="managed" className="text-xs">
                Managed
                {managedCount > 0 && <TabsBadge>{managedCount}</TabsBadge>}
              </TabsTrigger>
              <TabsTrigger value="external" className="text-xs">
                External
                {externalCount > 0 && <TabsBadge>{externalCount}</TabsBadge>}
              </TabsTrigger>
            </TabsList>
          </Tabs>
        )}

        <div className="w-full sm:ml-auto sm:w-auto">
          <SearchField
            containerClassName="w-full sm:w-auto"
            placeholder="Search services..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      </div>

      {/* Content */}
      {error ? (
        <div className="grid gap-3">
          <ErrorState
            title="Couldn't load services"
            description="Docker may be unreachable. Check system status."
          />
          <div className="flex items-center justify-center gap-2">
            <Button variant="outline" size="sm" onClick={() => void refresh()}>
              Retry
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                void handleSubmit(
                  "The Services page can't load container data from the Talome server. Can you check Docker and diagnose why the containers API is failing?",
                );
                if (!requestDesktopNavigation("/dashboard/assistant")) {
                  router.push("/dashboard/assistant");
                }
              }}
            >
              Ask Talome
            </Button>
          </div>
        </div>
      ) : isLoading ? (
        <div className="rounded-lg border overflow-hidden">
          <Table>
            <TableBody>
              {Array.from({ length: 6 }).map((_, i) => (
                <StackRowSkeleton key={i} />
              ))}
            </TableBody>
          </Table>
        </div>
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={Package01Icon}
          title={stacks.length === 0 ? "No services found" : "No services match"}
          description={
            stacks.length === 0
              ? "Install your first app to see it here."
              : "Try adjusting your search or filter."
          }
          action={
            stacks.length === 0 ? (
              <div className="flex items-center gap-2">
                <Button variant="outline" size="sm" asChild>
                  <Link href="/dashboard/apps">Browse App Store</Link>
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    openPaletteInChatMode("What apps should I install?");
                  }}
                >
                  Ask Talome
                </Button>
              </div>
            ) : undefined
          }
        />
      ) : (
        <ServiceStackList stacks={filtered} />
      )}
    </div>
    </WindowSidebarLayout>
  );
}
