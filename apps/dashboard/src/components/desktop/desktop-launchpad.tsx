"use client";

import { useMemo, useRef, useState, type ReactNode } from "react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { HugeiconsIcon, Cancel01Icon, Search01Icon, PackageOpenIcon, Tick01Icon } from "@/components/icons";
import { allNav, type NavItem } from "@/components/layout/nav-config";
import {
  extractLaunchableApps,
  LaunchableAppIcon,
  type LaunchableApp,
} from "@/components/widgets/launcher-widget";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogDescription, DialogOverlay, DialogPortal, DialogTitle } from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { SearchField } from "@/components/ui/search-field";
import { Skeleton } from "@/components/ui/skeleton";
import { useServiceStacks } from "@/hooks/use-service-stacks";
import { useUser } from "@/hooks/use-user";
import { useLaunchpadVisibility } from "@/hooks/use-launchpad-visibility";
import { cn } from "@/lib/utils";

interface DesktopLaunchpadProps {
  open: boolean;
  zIndex: number;
  onOpenChange: (open: boolean) => void;
  onLaunch: (item: NavItem) => void;
  onLaunchService: (app: LaunchableApp) => void;
}

function AppTile({ name, subtitle, icon, onLaunch, editing, hidden }: { name: string; subtitle?: string; icon: ReactNode; onLaunch: () => void; editing: boolean; hidden: boolean }) {
  return (
    <Button
      variant="ghost"
      data-launchpad-tile="true"
      className={cn("group h-auto min-h-36 min-w-0 flex-col justify-start gap-3 rounded-2xl whitespace-normal px-2 py-4 hover:bg-foreground/5 motion-reduce:transition-none", hidden && "opacity-45")}
      aria-label={editing ? `${hidden ? "Show" : "Hide"} ${name}${subtitle ? ` — ${subtitle}` : ""}` : subtitle ? `${name} — ${subtitle}` : name}
      aria-pressed={editing ? !hidden : undefined}
      title={subtitle ? `${name} — ${subtitle}` : name}
      onClick={onLaunch}
    >
      <span aria-hidden="true" className="relative flex size-16 shrink-0 items-center justify-center sm:size-[4.5rem]">
        {icon}
        {editing && <span className={cn("absolute -right-1 -top-1 flex size-6 items-center justify-center rounded-full border-2 border-card", hidden ? "bg-muted" : "bg-primary text-primary-foreground")}>
          {!hidden && <HugeiconsIcon icon={Tick01Icon} className="size-3.5" />}
        </span>}
      </span>
      <span className="flex w-full min-w-0 flex-col gap-1 text-center">
        <span className="line-clamp-2 break-words text-sm font-medium leading-snug">{name}</span>
        {subtitle && <span className="truncate text-xs font-normal text-muted-foreground">{subtitle}</span>}
      </span>
    </Button>
  );
}

const APP_GRID = "grid grid-cols-[repeat(auto-fill,minmax(6rem,1fr))] gap-x-3 gap-y-2 sm:grid-cols-[repeat(auto-fill,minmax(8.25rem,1fr))]";

export function DesktopLaunchpad({
  open,
  zIndex,
  onOpenChange,
  onLaunch,
  onLaunchService,
}: DesktopLaunchpadProps) {
  const { user, hasPermission } = useUser();
  const { stacks, isLoading, error, refresh } = useServiceStacks();
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState(false);
  const [storageError, setStorageError] = useState(false);
  const visibility = useLaunchpadVisibility(user?.userId);
  const [retrying, setRetrying] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const launchableApps = useMemo(() => extractLaunchableApps(stacks).sort((a, b) => a.name.localeCompare(b.name) || (a.collection ?? "").localeCompare(b.collection ?? "")), [stacks]);
  const duplicateNames = useMemo(() => {
    const counts = new Map<string, number>();
    for (const app of launchableApps) counts.set(app.name, (counts.get(app.name) ?? 0) + 1);
    return counts;
  }, [launchableApps]);
  const availableApps = allNav.filter((item) => (
    !item.action
    && item.url !== "/dashboard"
    && (!item.adminOnly || user?.role === "admin")
    && (!item.permission || hasPermission(item.permission))
  ));
  const search = query.trim().toLocaleLowerCase();
  const apps = availableApps.filter((item) => (editing || !visibility.hidden.has(`builtin:${item.url}`)) && item.title.toLocaleLowerCase().includes(search));
  const services = launchableApps.filter((app) => (editing || !visibility.hidden.has(`service:${app.id}`)) && `${app.name} ${app.collection ?? ""}`.toLocaleLowerCase().includes(search));
  const resultCount = apps.length + services.length;
  const toggle = (key: string) => setStorageError(!visibility.toggle(key));

  const retry = async () => {
    setRetrying(true);
    try {
      await refresh();
    } catch {
      // SWR retains the error so the retry remains available.
    } finally {
      setRetrying(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPortal>
        {/* Keep the desktop's dynamic window layer while delegating focus,
            outside interaction and Escape to the shared Dialog primitive. */}
        <DialogOverlay
          className="flex items-center justify-center bg-black/50 px-3 pt-12 pb-20 backdrop-blur-xl motion-reduce:animate-none sm:px-8"
          style={{ zIndex }}
        >
          <DialogPrimitive.Content
            className="flex max-h-full w-full max-w-[1000px] flex-col overflow-hidden rounded-3xl border border-border/70 bg-card/95 shadow-2xl outline-none"
            onOpenAutoFocus={(event) => {
              event.preventDefault();
              returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
              setQuery("");
              setEditing(false);
              inputRef.current?.focus();
            }}
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              if (returnFocusRef.current?.isConnected) returnFocusRef.current.focus();
            }}
          >
            <div className="flex shrink-0 flex-col gap-5 px-5 pt-6 pb-5 sm:px-8 sm:pt-7">
              <div className="flex items-start justify-between gap-4">
                <div className="flex flex-col gap-2">
                  <DialogTitle className="text-2xl font-semibold tracking-tight">Launchpad</DialogTitle>
                  <DialogDescription>{editing ? "Choose which apps appear here." : "Search or choose an app."}</DialogDescription>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                <Button variant={editing ? "secondary" : "ghost"} className="h-9 rounded-full px-3 text-xs sm:px-4 sm:text-sm" onClick={() => setEditing(current => !current)}>{editing ? "Done" : "Customize"}</Button>
                <DialogPrimitive.Close asChild>
                  <Button variant="ghost" size="icon" className="size-9 shrink-0 rounded-full" aria-label="Close Launchpad">
                    <HugeiconsIcon icon={Cancel01Icon} />
                  </Button>
                </DialogPrimitive.Close>
                </div>
              </div>
              <SearchField
                ref={inputRef}
                type="search"
                aria-label="Search apps"
                placeholder="Search apps…"
                containerClassName="w-full !max-w-none"
                className="!h-11 rounded-xl border-border/60 bg-background/60 !text-sm"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (editing || event.key !== "Enter" || event.nativeEvent.isComposing) return;
                  if (services[0]) onLaunchService(services[0]);
                  else if (apps[0]) onLaunch(apps[0]);
                }}
              />
              <p role="status" className="sr-only">
                {search ? `${resultCount} ${resultCount === 1 ? "app" : "apps"} found${isLoading ? "; installed apps are loading" : ""}.` : ""}
              </p>
            </div>

            <div className="flex min-h-0 flex-col gap-7 overflow-y-auto overscroll-contain px-5 pb-6 sm:px-8">
              {storageError && <Alert variant="destructive"><AlertDescription>Your browser couldn’t save this change. Allow local storage and try again.</AlertDescription></Alert>}
              {search && resultCount === 0 && !isLoading && !error ? (
                <EmptyState
                  icon={Search01Icon}
                  title="No apps found"
                  description={`No apps match “${query.trim()}”. Try another name.`}
                  action={<Button variant="outline" onClick={() => { setQuery(""); inputRef.current?.focus(); }}>Clear search</Button>}
                  className="p-6"
                />
              ) : null}

              {services.length > 0 || isLoading || error || (!search && !launchableApps.length) ? (
                <section aria-label="Installed applications" className="flex flex-col gap-3">
                  <h2 className="text-base font-semibold tracking-tight">Your apps</h2>
                  {error ? (
                    <Alert>
                      <AlertTitle>Installed apps couldn’t be loaded</AlertTitle>
                      <AlertDescription>
                        <p>Check your connection to Talome, then try again.</p>
                        <Button variant="outline" size="sm" disabled={retrying} onClick={() => void retry()}>{retrying ? "Retrying…" : "Try again"}</Button>
                      </AlertDescription>
                    </Alert>
                  ) : null}
                  {isLoading ? (
                    <div role="status" aria-label="Loading installed apps" className={APP_GRID}>
                      {Array.from({ length: 6 }, (_, index) => (
                        <div key={index} aria-hidden="true" className="flex min-h-36 flex-col items-center gap-3 py-4">
                          <Skeleton className="size-16 rounded-2xl sm:size-[4.5rem]" /><Skeleton className="h-4 w-20" />
                        </div>
                      ))}
                    </div>
                  ) : services.length > 0 ? (
                    <div className={APP_GRID}>
                      {services.map((app) => <AppTile key={app.id} name={app.name}
                        subtitle={(duplicateNames.get(app.name) ?? 0) > 1 ? app.collection ?? app.container.name : undefined}
                        editing={editing} hidden={visibility.hidden.has(`service:${app.id}`)}
                        icon={<LaunchableAppIcon app={app} className="!size-16 !rounded-2xl shadow-sm sm:!size-[4.5rem] sm:!rounded-[1.25rem]" iconClassName="!size-9" />}
                        onLaunch={() => editing ? toggle(`service:${app.id}`) : onLaunchService(app)} />)}
                    </div>
                  ) : !error && !search ? (
                    <EmptyState
                      icon={PackageOpenIcon}
                      title="No apps with a web interface"
                      description="Running apps with a browser interface appear here. Background services remain in Services."
                      className="p-6"
                    />
                  ) : null}
                </section>
              ) : null}
              {apps.length > 0 ? (
                <section aria-label="Talome applications" className="flex flex-col gap-3">
                  <h2 className="text-base font-semibold tracking-tight">Talome</h2>
                  <div className={APP_GRID}>
                    {apps.map((item) => (
                      <AppTile
                        key={item.url}
                        name={item.title}
                        editing={editing} hidden={visibility.hidden.has(`builtin:${item.url}`)}
                        icon={<span className="flex size-16 items-center justify-center rounded-2xl border border-border/60 bg-background/65 shadow-sm sm:size-[4.5rem] sm:rounded-[1.25rem]"><HugeiconsIcon icon={item.icon} className="size-8 sm:size-9" strokeWidth={1.4} /></span>}
                        onLaunch={() => editing ? toggle(`builtin:${item.url}`) : onLaunch(item)}
                      />
                    ))}
                  </div>
                </section>
              ) : null}

            </div>
            <div className="flex shrink-0 items-center justify-between gap-3 border-t border-border/50 px-5 py-3 text-xs text-muted-foreground sm:px-8">
              <span>{editing ? "Visibility is saved for you in this browser." : "Background services stay in Services."}</span>
              {editing && <Button variant="ghost" size="sm" className="h-7 shrink-0 text-xs" onClick={() => setStorageError(!visibility.reset())}>Reset</Button>}
            </div>
          </DialogPrimitive.Content>
        </DialogOverlay>
      </DialogPortal>
    </Dialog>
  );
}
