import { useState } from "react";
import Image from "next/image";
import Link from "next/link";
import type { CatalogApp } from "@talome/types";
import { HugeiconsIcon, Delete02Icon, AiChat02Icon, ArrowUp01Icon } from "@/components/icons";

const SOURCE_LABELS: Record<string, string> = {
  talon: "Talome",
  casaos: "CasaOS",
  umbrel: "Umbrel",
  "user-created": "My Apps",
};

function needsAiSetup(app: CatalogApp): boolean {
  return !app.installed && !!app.env?.some((e) => e.required && !e.default);
}

function isRemoteUrl(url: string | undefined): url is string {
  return !!url && !url.startsWith("file://");
}

export function AppCard({ app, onDelete, priority = false, eager = false, hasUpdate = false }: { app: CatalogApp; onDelete?: (appId: string) => void; priority?: boolean; eager?: boolean; hasUpdate?: boolean }) {
  const [coverFailed, setCoverFailed] = useState(false);
  const [iconFailed, setIconFailed] = useState(false);

  const isInstalled = !!app.installed;
  const status = app.installed?.status;
  const hasRealIcon = isRemoteUrl(app.iconUrl) && !iconFailed;
  const isUserCreated = app.storeId === "user-apps";
  const screenshotCover = (app.screenshots || []).find(isRemoteUrl);
  const coverUrl = !coverFailed ? (isRemoteUrl(app.coverUrl) ? app.coverUrl : screenshotCover) : undefined;
  const categoryLabel = app.category.charAt(0).toUpperCase() + app.category.slice(1);
  const requiresSetup = needsAiSetup(app);
  const statusLabel =
    status === "running" ? "Running" :
    status === "stopped" ? "Stopped" :
    status === "updating" ? "Updating" :
    status === "installing" ? "Installing" :
    "Installed";

  return (
    <Link
      href={`/dashboard/apps/${app.storeId}/${app.id}`}
      className="app-card group/card"
    >
      <div className="app-card-media" data-has-cover={coverUrl ? "true" : "false"}>
        {coverUrl ? (
          <Image
            src={coverUrl}
            alt=""
            className="object-cover" fill
            sizes="(max-width: 640px) 50vw, (max-width: 1024px) 33vw, 280px"
            priority={priority}
            loading={priority ? undefined : eager ? "eager" : "lazy"}
            onError={() => setCoverFailed(true)}
          />
        ) : null}
        <div
          className="app-card-media-fallback"
          aria-hidden="true"
          style={coverUrl ? { display: "none" } : undefined}
        />
        {isInstalled && hasUpdate && (
          <span className="absolute top-2.5 left-2.5 z-[2] flex items-center gap-1 rounded-full bg-foreground/90 px-2 py-0.5 text-[10px] font-medium text-background backdrop-blur-sm">
            <HugeiconsIcon icon={ArrowUp01Icon} size={10} />
            Update
          </span>
        )}
        {isInstalled ? (
          <span className="app-card-installed-badge" data-status={status || "unknown"}>
            {statusLabel}
          </span>
        ) : requiresSetup ? (
          <span className="app-card-setup-badge">
            <HugeiconsIcon icon={AiChat02Icon} size={10} />
            Setup
          </span>
        ) : null}
      </div>
      {onDelete && (
        <button
          className="absolute top-2 left-2 z-10 flex items-center justify-center size-7 rounded-md bg-background/80 backdrop-blur-sm border border-border/60 text-muted-foreground hover:text-destructive hover:border-destructive/40 transition-colors opacity-0 group-hover/card:opacity-100"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onDelete(app.id);
          }}
          title="Remove app"
        >
          <HugeiconsIcon icon={Delete02Icon} size={14} />
        </button>
      )}

      <div className="app-card-body">
        <div className="flex items-center gap-3.5 min-w-0">
          <div className="app-card-icon">
            {hasRealIcon ? (
              <Image
                src={app.iconUrl!}
                alt=""
                className="object-cover" fill
                sizes="42px"
                loading={eager || priority ? "eager" : "lazy"}
                onError={() => setIconFailed(true)}
              />
            ) : null}
            <span className={hasRealIcon ? "hidden" : ""}>{app.icon}</span>
          </div>

          <div className="min-w-0 flex-1">
            <p className="app-card-name">{app.installed?.displayName || app.name}</p>
            <p className="app-card-meta-line">
              {categoryLabel}
              {app.source !== "talome" ? ` · ${SOURCE_LABELS[app.source] || app.source}` : ""}
            </p>
          </div>
        </div>
        <p className="app-card-desc">{app.tagline || app.description}</p>
      </div>
    </Link>
  );
}
