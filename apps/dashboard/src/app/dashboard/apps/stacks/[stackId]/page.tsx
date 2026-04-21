"use client";

import { useEffect } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import Image from "next/image";
import useSWR from "swr";
import { useSetAtom } from "jotai";
import { pageTitleAtom } from "@/atoms/page-title";
import { Button } from "@/components/ui/button";
import {
  HugeiconsIcon,
  Package01Icon,
  ArrowRight01Icon,
  AiChat02Icon,
  CheckmarkCircle01Icon,
} from "@/components/icons";
import { CORE_URL } from "@/lib/constants";
import type { StackApp, EnrichedStackApp } from "@talome/types";

/* ── Types ─────────────────────────────────────────────── */

interface EnrichedStackDetail {
  id: string;
  name: string;
  description: string;
  tagline: string;
  author: string;
  tags: string[];
  version: string;
  createdAt: string;
  apps: (StackApp & EnrichedStackApp)[];
  postInstallPrompt?: string;
}

/* ── Helpers ───────────────────────────────────────────── */

const fetcher = (url: string) => fetch(url).then((r) => r.json());

function extractPorts(compose?: string): number[] {
  if (!compose) return [];
  return [...compose.matchAll(/- "?(\d+):\d+"?/g)].map((m) => parseInt(m[1], 10));
}

/* ── Page ──────────────────────────────────────────────── */

export default function StackDetailPage() {
  const params = useParams();
  const stackId = params.stackId as string;
  const setPageTitle = useSetAtom(pageTitleAtom);

  const { data: stack } = useSWR<EnrichedStackDetail>(
    `${CORE_URL}/api/stacks/${encodeURIComponent(stackId)}`,
    fetcher,
    { revalidateOnFocus: false },
  );

  // Set title synchronously from URL slug, update when SWR data arrives.
  // No cleanup — stale pageTitleAtom is harmless (header ignores it when not in drilldown).
  // This avoids the AnimatePresence race where cleanup fires before new data loads.
  useEffect(() => {
    setPageTitle(
      stack?.name ??
        stackId.split("-").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" "),
    );
  }, [stack?.name, stackId, setPageTitle]);

  if (!stack) {
    return (
      <div className="mx-auto w-full max-w-xl grid gap-6 py-12">
        <div className="h-6 w-48 bg-muted/50 rounded animate-pulse" />
        <div className="h-4 w-64 bg-muted/30 rounded animate-pulse" />
        <div className="h-10 w-full bg-muted/30 rounded-lg animate-pulse" />
        <div className="space-y-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-14 bg-muted/20 rounded-lg animate-pulse" />
          ))}
        </div>
      </div>
    );
  }

  const appNames = stack.apps.map((a) => a.name).join(", ");
  const installedApps = stack.apps.filter((a) => a.installed);
  const missingApps = stack.apps.filter((a) => !a.installed);
  const installedCount = installedApps.length;
  const allInstalled = installedCount === stack.apps.length;

  const prompt = allInstalled
    ? `I have the "${stack.name}" stack fully running (${appNames}). Help me configure and wire them together for optimal setup.`
    : installedCount > 0
      ? `Install the "${stack.name}" stack for me. Already running: ${installedApps.map((a) => a.name).join(", ")}. Still need: ${missingApps.map((a) => a.name).join(", ")}. Walk me through any required configuration.`
      : `Install the "${stack.name}" stack for me. The apps are: ${appNames}. Walk me through any required configuration.`;

  return (
    <div className="mx-auto w-full max-w-xl grid gap-8 py-4 pb-12">
      {/* ── Hero ── */}
      <div className="grid gap-2">
        <h1 className="text-xl font-medium">{stack.name}</h1>
        <p className="text-sm text-muted-foreground leading-relaxed">{stack.tagline}</p>
        <div className="flex flex-wrap gap-1.5 mt-1">
          {stack.tags.map((tag) => (
            <span key={tag} className="app-detail-tag">{tag}</span>
          ))}
          <span className="app-detail-tag">
            {stack.apps.length} app{stack.apps.length !== 1 ? "s" : ""}
          </span>
          <span className="app-detail-tag">by {stack.author}</span>
        </div>
      </div>

      {/* ── Primary action ── */}
      <div className="grid gap-2">
        <Button size="lg" className="w-full gap-2" asChild>
          <Link href={`/dashboard/assistant?prompt=${encodeURIComponent(prompt)}`}>
            <HugeiconsIcon icon={AiChat02Icon} size={16} />
            {allInstalled
              ? "Configure with Assistant"
              : installedCount > 0
                ? `Install ${missingApps.length} remaining`
                : "Install with Assistant"}
          </Link>
        </Button>
        {installedCount > 0 && !allInstalled && (
          <p className="text-xs text-muted-foreground text-center">
            {`${installedCount} of ${stack.apps.length} already running`}
          </p>
        )}
      </div>

      {/* ── Apps in this stack ── */}
      <section className="grid gap-3">
        <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          Apps in this stack
        </p>
        <div className="rounded-xl border border-border bg-card divide-y divide-border overflow-hidden">
          {stack.apps.map((app) => {
            const ports = extractPorts(app.compose);
            const hasLink = !!app.storeId;
            const isInstalled = !!app.installed;
            const hasIcon = app.iconUrl && !app.iconUrl.startsWith("file://");
            const envVars = app.configSchema?.envVars ?? [];
            const requiredVars = envVars.filter((v) => v.required && !v.secret);

            const content = (
              <div className="px-4 py-3.5 flex items-center gap-3 hover:bg-muted/20 transition-colors">
                <div className="size-9 rounded-lg bg-muted/50 flex items-center justify-center shrink-0 text-base overflow-hidden relative">
                  {hasIcon ? (
                    <Image src={app.iconUrl!} alt="" className="object-cover" fill sizes="36px" />
                  ) : app.icon ? (
                    <span>{app.icon}</span>
                  ) : (
                    <HugeiconsIcon icon={Package01Icon} size={16} className="text-muted-foreground" />
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-medium">{app.name}</p>
                    {ports.length > 0 && (
                      <span className="text-xs text-muted-foreground tabular-nums">:{ports[0]}</span>
                    )}
                    {isInstalled && (
                      <HugeiconsIcon icon={CheckmarkCircle01Icon} size={13} className="text-primary/60 shrink-0" />
                    )}
                  </div>
                  {(app.tagline || app.category) && (
                    <p className="text-xs text-muted-foreground mt-0.5 line-clamp-1">
                      {app.tagline || app.category}
                    </p>
                  )}
                  {requiredVars.length > 0 && (
                    <p className="text-xs text-muted-foreground mt-1 line-clamp-1">
                      {requiredVars.map((v) => v.key).join(" · ")}
                    </p>
                  )}
                </div>
                {hasLink && (
                  <HugeiconsIcon icon={ArrowRight01Icon} size={14} className="text-dim-foreground shrink-0" />
                )}
              </div>
            );

            return hasLink ? (
              <Link key={app.appId} href={`/dashboard/apps/${app.storeId}/${app.appId}`}>
                {content}
              </Link>
            ) : (
              <div key={app.appId}>{content}</div>
            );
          })}
        </div>
      </section>

      {/* ── About ── */}
      <section className="grid gap-3">
        <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">About</p>
        <p className="text-sm text-muted-foreground leading-relaxed">{stack.description}</p>
      </section>

      {/* ── Information ── */}
      <section className="grid gap-3">
        <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Information</p>
        <div className="rounded-xl border border-border bg-card divide-y divide-border overflow-hidden">
          <div className="px-4 py-3 flex items-center justify-between">
            <span className="text-sm text-muted-foreground">Author</span>
            <span className="text-sm font-medium">{stack.author}</span>
          </div>
          <div className="px-4 py-3 flex items-center justify-between">
            <span className="text-sm text-muted-foreground">Version</span>
            <span className="text-sm font-medium">{stack.version}</span>
          </div>
          <div className="px-4 py-3 flex items-center justify-between">
            <span className="text-sm text-muted-foreground">Apps</span>
            <span className="text-sm font-medium">{stack.apps.length}</span>
          </div>
        </div>
      </section>
    </div>
  );
}
