import Image from "next/image";
import Link from "next/link";
import { HugeiconsIcon, Package01Icon, CheckmarkCircle01Icon } from "@/components/icons";
import type { StackListItem, EnrichedStackApp } from "@talome/types";

function StackAppIcon({ app }: { app: EnrichedStackApp }) {
  const hasImage = app.iconUrl && !app.iconUrl.startsWith("file://");

  return (
    <div className="relative size-9 rounded-[10px] bg-card/60 backdrop-blur-sm flex items-center justify-center shrink-0 overflow-hidden border border-white/[0.06]">
      {hasImage ? (
        <Image
          src={app.iconUrl!}
          alt=""
          className="object-cover" fill
          sizes="36px"
        />
      ) : app.icon ? (
        <span className="text-lg leading-none">{app.icon}</span>
      ) : (
        <HugeiconsIcon icon={Package01Icon} size={16} className="text-dim-foreground" />
      )}
    </div>
  );
}

interface StackCardProps {
  stack: StackListItem;
}

export function StackCard({ stack }: StackCardProps) {
  const visibleApps = stack.apps.slice(0, 6);
  const remaining = Math.max(0, stack.apps.length - visibleApps.length);
  const installedCount = stack.apps.filter((a) => a.installed).length;

  return (
    <Link
      href={`/dashboard/apps/stacks/${stack.id}`}
      className="app-card stack-card min-w-[280px] max-w-[340px] shrink-0 h-[248px]"
      data-stack-id={stack.id}
    >
      {/* Hero — app icons on gradient */}
      <div className="app-card-media">
        <div className="app-card-media-fallback">
          <div className="flex items-center gap-1.5">
            {visibleApps.map((app) => (
              <StackAppIcon key={app.appId} app={app} />
            ))}
            {remaining > 0 && (
              <div className="size-9 rounded-[10px] bg-card/40 backdrop-blur-sm flex items-center justify-center shrink-0 text-xs text-muted-foreground font-medium border border-white/[0.04]">
                +{remaining}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Body */}
      <div className="app-card-body stack-card-body">
        <div className="min-w-0">
          <p className="app-card-name">{stack.name}</p>
          <p className="app-card-desc mt-1">{stack.tagline}</p>
        </div>
        <div className="flex items-center gap-2 stack-card-meta">
          <p className="text-xs text-muted-foreground">
            {stack.appCount} app{stack.appCount !== 1 ? "s" : ""}
          </p>
          {installedCount > 0 && (
            <span className="flex items-center gap-1 text-xs text-muted-foreground">
              <HugeiconsIcon icon={CheckmarkCircle01Icon} size={12} className="text-primary" />
              {installedCount === stack.appCount ? "All installed" : `${installedCount} installed`}
            </span>
          )}
        </div>
      </div>
    </Link>
  );
}
