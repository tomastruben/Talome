"use client";

import { useState, useMemo } from "react";
import { useRouter } from "next/navigation";
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
import { HugeiconsIcon, Package01Icon } from "@/components/icons";
import { useAssistant } from "@/components/assistant/assistant-context";
import { Button } from "@/components/ui/button";

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

  const totalContainers = stacks.reduce((sum, s) => sum + s.totalCount, 0);
  const runningCount = stacks.filter((s) => s.status === "running").length;
  const stoppedCount = stacks.filter((s) => s.status === "stopped").length;
  const isManaged = (s: (typeof stacks)[number]) =>
    s.kind === "talome" || s.primaryContainer.labels["talome.managed"] === "true";
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
  }, [stacks, search, statusFilter, sourceFilter]);

  return (
    <div className="grid gap-5">
      {/* Controls */}
      <div className="page-controls-row flex-wrap gap-2">
        <Tabs
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
                router.push("/dashboard/assistant");
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
                  <a href="/dashboard/apps">Browse App Store</a>
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
  );
}
