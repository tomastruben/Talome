"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { DesktopAppToolbar } from "@/components/desktop/desktop-app-toolbar";
import { useIsEmbeddedFrame } from "@/hooks/use-desktop-mode";
import { useRouter, useSearchParams } from "next/navigation";
import { useSetAtom } from "jotai";
import useSWR from "swr";
import { toast } from "sonner";
import type { TalomeAppAction, TalomeAppSpec, TalomeDataSource } from "@talome/types";
import { Menu01Icon, AiMagicIcon, HugeiconsIcon } from "@/components/icons";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsPanel, TabsTab } from "@/components/ui/tabs";
import { ErrorState } from "@/components/ui/empty-state";
import { CORE_URL } from "@/lib/constants";
import { requestDesktopNavigation } from "@/lib/desktop-navigation";
import { cn } from "@/lib/utils";
import { desktopAppActionsAtom } from "@/atoms/desktop-app-actions";
import { pageTitleAtom } from "@/atoms/page-title";
import { useConfirmAction } from "@/hooks/use-confirm-action";
import { NativeAppBlockRenderer } from "./native-app-blocks";
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { SourceList, SourceListItem, SourceListSection, WindowSidebarLayout, WINDOW_SIDEBAR_REPLACES } from "@/components/ui/source-list";
import { resolveApplicationIcon } from "./native-app-icons";

interface StoredAppSpecResponse {
  appId: string;
  storeId: string;
  revision: number;
  status: "draft" | "approved" | "disabled";
  spec: TalomeAppSpec;
}

interface NativeDataState {
  values: Record<string, unknown>;
  errors: Record<string, string>;
}

const SPAN_CLASSES = {
  1: "@3xl/native:col-span-1",
  2: "@3xl/native:col-span-2",
  3: "@3xl/native:col-span-3",
  4: "@3xl/native:col-span-4",
} as const;

async function fetchSpec(url: string): Promise<StoredAppSpecResponse> {
  const response = await fetch(url, { credentials: "include" });
  if (!response.ok) throw new Error(response.status === 404 ? "Native experience not found" : "Unable to load native experience");
  return response.json();
}

async function fetchSource(
  storeId: string,
  appId: string,
  source: TalomeDataSource,
): Promise<unknown> {
  if (source.kind === "static") return source.value;
  const response = await fetch(
    `${CORE_URL}/api/app-specs/${encodeURIComponent(storeId)}/${encodeURIComponent(appId)}/data/${encodeURIComponent(source.id)}`,
    { credentials: "include" },
  );
  const body = await response.json().catch(() => ({})) as { data?: unknown; error?: string };
  if (!response.ok) throw new Error(body.error || `Unable to load ${source.id}`);
  return body.data;
}

async function fetchAllSources(
  storeId: string,
  appId: string,
  sources: TalomeDataSource[],
): Promise<NativeDataState> {
  const results = await Promise.allSettled(
    sources.map(async (source) => [source.id, await fetchSource(storeId, appId, source)] as const),
  );
  const values: Record<string, unknown> = {};
  const errors: Record<string, string> = {};
  results.forEach((result, index) => {
    const source = sources[index];
    if (result.status === "fulfilled") values[result.value[0]] = result.value[1];
    else errors[source.id] = result.reason instanceof Error ? result.reason.message : String(result.reason);
  });
  return { values, errors };
}

function refreshInterval(sources: TalomeDataSource[]) {
  const intervals = sources.flatMap((source) => {
    if (source.kind === "static") return [];
    return [source.refreshMs ?? 30_000];
  });
  return intervals.length ? Math.min(...intervals) : 0;
}

export function NativeAppRuntime({ storeId, appId }: { storeId: string; appId: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const surfaceFromUrl = searchParams.get("view");
  const viewQuery = searchParams.toString();
  const embedded = useIsEmbeddedFrame();
  const setPageTitle = useSetAtom(pageTitleAtom);
  const setDesktopActions = useSetAtom(desktopAppActionsAtom);
  const [pendingActionId, setPendingActionId] = useState<string>();
  const [selectedSurfaceId, setSelectedSurfaceId] = useState<string | undefined>(surfaceFromUrl ?? undefined);
  useEffect(() => {
    setSelectedSurfaceId(surfaceFromUrl ?? undefined);
  }, [surfaceFromUrl, storeId, appId]);

  const selectSurface = (surfaceId: string) => {
    setSelectedSurfaceId(surfaceId);
    const params = new URLSearchParams(searchParams.toString());
    params.set("view", surfaceId);
    router.push(`/dashboard/native-apps/${encodeURIComponent(storeId)}/${encodeURIComponent(appId)}?${params.toString()}`, { scroll: false });
  };
  const { confirmAction, ConfirmDialog } = useConfirmAction(false);
  const specUrl = `${CORE_URL}/api/app-specs/${encodeURIComponent(storeId)}/${encodeURIComponent(appId)}`;
  const { data: stored, error: specError, isLoading: specLoading, mutate: refreshSpec } = useSWR(
    specUrl,
    fetchSpec,
    { revalidateOnFocus: false },
  );
  const spec = stored?.spec;
  const dataKey = spec ? ["native-app-data", storeId, appId, stored.revision] as const : null;
  const {
    data: nativeData,
    isLoading: dataLoading,
    isValidating: dataRefreshing,
    mutate: refreshData,
  } = useSWR(
    dataKey,
    () => fetchAllSources(storeId, appId, spec!.dataSources),
    {
      refreshInterval: spec ? refreshInterval(spec.dataSources) : 0,
      revalidateOnFocus: false,
      keepPreviousData: true,
    },
  );

  const openAssistant = useCallback((prompt: string) => {
    const returnParams = new URLSearchParams(viewQuery);
    if (selectedSurfaceId) returnParams.set("view", selectedSurfaceId);
    const returnQuery = returnParams.toString();
    const params = new URLSearchParams({
      prompt,
      from: `/dashboard/native-apps/${storeId}/${appId}${returnQuery ? `?${returnQuery}` : ""}`,
    });
    const href = `/dashboard/assistant?${params.toString()}`;
    if (!requestDesktopNavigation(href)) router.push(href);
  }, [appId, router, storeId, selectedSurfaceId, viewQuery]);

  useEffect(() => {
    const selected = spec?.surfaces.find((surface) => surface.id === selectedSurfaceId) ?? spec?.surfaces[0];
    setPageTitle(embedded && spec && spec.surfaces.length > 1 ? selected?.title ?? spec.name : spec?.name ?? null);
    if (!spec) return () => setPageTitle(null);
    setDesktopActions([
      {
        id: "native-app-assistant",
        icon: "assistant",
        label: `Ask about ${spec.name}`,
        onSelect: () => openAssistant(
          `${spec.assistant.context}\n\nReview the current app state and recommend the next best action.`,
        ),
      },
    ]);
    return () => {
      setPageTitle(null);
      setDesktopActions([]);
    };
  }, [embedded, openAssistant, selectedSurfaceId, setDesktopActions, setPageTitle, spec]);

  const runAction = useCallback(async (
    action: TalomeAppAction,
    values: Record<string, string | number | boolean> = {},
  ) => {
    if (!spec) return;
    const hasMissingRequiredInput = action.input?.some((field) => (
      field.required && (values[field.id] === undefined || values[field.id] === "")
    ));
    if (action.input?.length && hasMissingRequiredInput) {
      const fieldList = action.input.map((field) => `${field.label}${field.required ? " (required)" : ""}`).join(", ");
      openAssistant(
        `${spec.assistant.context}\n\nI want to run “${action.label}”. Collect these inputs from me if needed: ${fieldList}. Then use inspect_native_app and run_native_app_action.`,
      );
      return;
    }

    // Destructive actions always ask, even when the AppSpec declares no
    // confirmation text (core refuses them unconfirmed as well).
    const destructive = "destructive" in action && action.destructive === true;
    const declared = "confirmation" in action ? action.confirmation : undefined;
    const needsConfirm = Boolean(declared) || destructive;
    if (needsConfirm) {
      // The AppSpec's confirmation is the one sentence its author wrote for
      // this dialog: a question becomes the title, anything else is the
      // consequence line under "{label}?".
      const declaredText = declared?.trim();
      const declaredIsQuestion = Boolean(declaredText?.endsWith("?"));
      const confirmed = await confirmAction({
        title: declaredIsQuestion ? declaredText! : `${action.label}?`,
        description: !declaredIsQuestion && declaredText ? declaredText : action.description,
        recovery: destructive
          ? "This can't be undone."
          : `${spec.name} keeps its data. You can run this again at any time.`,
        irreversible: destructive,
        confirmLabel: action.label,
        variant: destructive ? "destructive" : "default",
      });
      if (!confirmed) return;
    }

    setPendingActionId(action.id);
    try {
      const response = await fetch(
        `${CORE_URL}/api/app-specs/${encodeURIComponent(storeId)}/${encodeURIComponent(appId)}/actions/${encodeURIComponent(action.id)}`,
        {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ confirmed: needsConfirm, values }),
        },
      );
      const result = await response.json().catch(() => ({})) as {
        ok?: boolean;
        kind?: "assistant" | "result";
        prompt?: string;
        error?: string;
      };
      if (!response.ok || !result.ok) {
        throw new Error(result.error || `Talome couldn't run "${action.label}". Try again, or ask Talome to check ${spec.name}.`);
      }
      if (result.kind === "assistant" && result.prompt) openAssistant(result.prompt);
      else {
        toast.success(`Ran ${action.label} in ${spec.name}`);
        await refreshData();
      }
    } catch (error) {
      toast.error(`Couldn't run "${action.label}"`, {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setPendingActionId(undefined);
    }
  }, [appId, confirmAction, openAssistant, refreshData, spec, storeId]);

  const dataErrors = useMemo(() => Object.entries(nativeData?.errors ?? {}), [nativeData?.errors]);

  if (specLoading) {
    return (
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 @container/native">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-4 w-96 max-w-full" />
        <div className="grid grid-cols-1 gap-6 @lg/native:grid-cols-2 @3xl/native:grid-cols-4">
          {Array.from({ length: 4 }, (_, index) => <Skeleton key={index} className="h-48 w-full" />)}
        </div>
      </div>
    );
  }

  if (specError || !spec) {
    return (
      <div className="mx-auto w-full max-w-3xl">
        <ErrorState
          title="Native experience unavailable"
          description={specError instanceof Error ? specError.message : "This application does not have an approved AppSpec."}
          onRetry={() => void refreshSpec()}
        />
      </div>
    );
  }

  const activeSurface = spec.surfaces.find((surface) => surface.id === selectedSurfaceId) ?? spec.surfaces[0];
  const primaryAction = activeSurface.primaryActionId
    ? spec.actions.find((action) => action.id === activeSurface.primaryActionId)
    : undefined;
  const appIcon = resolveApplicationIcon(spec.icon, spec.name);

  const renderSurface = (surface: TalomeAppSpec["surfaces"][number]) => (
    <div role="region" aria-label={surface.title} data-native-surface={surface.id} data-native-layout={surface.layout} className={cn("flex w-full min-w-0 flex-col gap-6 pt-1", surface.layout === "detail" && "max-w-3xl")}>
      <div className={cn("grid grid-cols-1 gap-6", surface.layout === "dashboard" && "@lg/native:grid-cols-2 @3xl/native:grid-cols-4")}>
        {surface.blocks.filter((block) => block.component !== "actions" || block.actionIds.some((id) => id !== surface.primaryActionId)).map((block) => (
          <div
            key={block.id}
            data-native-block={block.id}
            className={cn("min-w-0 @container/block", surface.layout === "dashboard" && ["@lg/native:col-span-2", SPAN_CLASSES[block.span ?? 2]])}
          >
            <NativeAppBlockRenderer
              block={block}
              data={nativeData?.values ?? {}}
              actions={spec.actions}
              primaryActionId={surface.primaryActionId}
              pendingActionId={pendingActionId}
              onAction={runAction}
            />
          </div>
        ))}
      </div>
    </div>
  );

  return (
    <WindowSidebarLayout sidebar={spec.surfaces.length > 1 ? (
      <SourceList label={`${spec.name} views`}>
        <SourceListSection title={spec.name}>
          {spec.surfaces.map((surface) => (
            <SourceListItem key={surface.id} label={surface.title} active={surface.id === activeSurface.id} onSelect={() => selectSurface(surface.id)} />
          ))}
        </SourceListSection>
      </SourceList>
    ) : null}>
    <div data-native-app={spec.appId} className="mx-auto flex w-full max-w-screen-2xl flex-col gap-6 pb-8 @container/native">
      {!embedded && <header className="flex flex-col gap-4 @3xl/native:flex-row @3xl/native:items-start @3xl/native:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <div className="flex size-12 shrink-0 items-center justify-center rounded-xl border bg-card shadow-sm">
            <HugeiconsIcon icon={appIcon} size={30} className="text-foreground" aria-hidden />
          </div>
          <div className="min-w-0">
            <h1 className="break-words text-2xl font-medium tracking-tight">{spec.name}</h1>
            <p className="mt-2 max-w-3xl whitespace-pre-line text-sm leading-relaxed text-muted-foreground">{spec.description}</p>
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          {primaryAction ? (
            <Button disabled={Boolean(pendingActionId)} onClick={() => runAction(primaryAction)}>
              {pendingActionId === primaryAction.id ? <Spinner data-icon="inline-start" /> : null}
              {pendingActionId === primaryAction.id ? "Working…" : primaryAction.label}
            </Button>
          ) : null}
          <Button
            variant="outline"
            onClick={() => openAssistant(`${spec.assistant.context}\n\nHelp me with ${spec.name}.`)}
          >
            <HugeiconsIcon icon={AiMagicIcon} size={16} data-icon="inline-start" />
            Ask Talome
          </Button>
        </div>
      </header>}

      {embedded && (
        <DesktopAppToolbar data-compact-toolbar="" className="flex min-w-0 items-center justify-end gap-2">
          {spec.surfaces.length > 1 && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="icon-sm" className={WINDOW_SIDEBAR_REPLACES} aria-label={`Change view: ${activeSurface.title}`} title={`Change view: ${activeSurface.title}`}>
                  <HugeiconsIcon icon={Menu01Icon} size={16} aria-hidden />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                <DropdownMenuRadioGroup value={activeSurface.id} onValueChange={selectSurface}>
                  {spec.surfaces.map((surface) => <DropdownMenuRadioItem key={surface.id} value={surface.id}>{surface.title}</DropdownMenuRadioItem>)}
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          {primaryAction && (
            <Button className="min-w-0 shrink" size="sm" title={primaryAction.label} aria-label={pendingActionId === primaryAction.id ? `${primaryAction.label}: working` : primaryAction.label} disabled={Boolean(pendingActionId)} onClick={() => runAction(primaryAction)}>
              {pendingActionId === primaryAction.id ? <Spinner data-icon="inline-start" /> : null}
              <span className="truncate">{pendingActionId === primaryAction.id ? "Working…" : primaryAction.label}</span>
            </Button>
          )}
        </DesktopAppToolbar>
      )}

      {dataErrors.length ? (
        <Alert variant="destructive">
          <AlertTitle>Some app data is unavailable</AlertTitle>
          <AlertDescription>
            {dataErrors.map(([sourceId, message]) => `${sourceId}: ${message}`).join(" · ")}
          </AlertDescription>
          <Button variant="outline" size="sm" className="mt-3 w-fit" disabled={dataRefreshing} onClick={() => void refreshData()}>
            {dataRefreshing ? <Spinner data-icon="inline-start" /> : null}
            Retry app data
          </Button>
        </Alert>
      ) : null}

      {dataLoading && !nativeData ? (
        <div className="grid grid-cols-1 gap-6 @lg/native:grid-cols-2 @3xl/native:grid-cols-4">
          {Array.from({ length: 4 }, (_, index) => <Skeleton key={index} className="h-48 w-full" />)}
        </div>
      ) : spec.surfaces.length === 1 ? renderSurface(spec.surfaces[0]) : embedded ? renderSurface(activeSurface) : (
        <Tabs value={activeSurface.id} onValueChange={selectSurface}>
          {!embedded && (
            <div className="min-w-0 max-w-full overflow-x-auto">
              <TabsList variant="underline" aria-label={`${spec.name} views`}>
                {spec.surfaces.map((surface) => <TabsTab key={surface.id} value={surface.id}>{surface.title}</TabsTab>)}
              </TabsList>
            </div>
          )}
          {spec.surfaces.map((surface) => (
            <TabsPanel key={surface.id} value={surface.id}>{renderSurface(surface)}</TabsPanel>
          ))}
        </Tabs>
      )}

      <ConfirmDialog />
    </div>
    </WindowSidebarLayout>
  );
}
