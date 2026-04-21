"use client";

import Link from "next/link";
import {
  HugeiconsIcon,
  Message01Icon,
  DownloadSquare01Icon,
  Package01Icon,
  Activity01Icon,
} from "@/components/icons";
import { Widget, WidgetHeader } from "./widget";
import { useAssistant } from "@/components/assistant/assistant-context";
import { cn } from "@/lib/utils";

interface Action {
  label: string;
  description: string;
  icon: typeof Message01Icon;
  href?: string;
  onClick?: () => void;
}

function ActionTile({ action, className }: { action: Action; className?: string }) {
  const content = (
    <div
      className={cn(
        "flex flex-col gap-2 px-4 py-4 h-full",
        "transition-colors duration-100",
        "hover:bg-muted/30 active:bg-muted/50",
        "cursor-pointer",
        className
      )}
    >
      <div className="flex items-center justify-between">
        <HugeiconsIcon icon={action.icon} size={15} className="text-muted-foreground" />
      </div>
      <div>
        <p className="text-sm font-medium leading-snug">{action.label}</p>
        <p className="text-xs text-muted-foreground leading-snug mt-0.5 text-balance">
          {action.description}
        </p>
      </div>
    </div>
  );

  if (action.href) {
    return (
      <Link href={action.href} className="block h-full">
        {content}
      </Link>
    );
  }

  return (
    <button type="button" className="block w-full h-full text-left" onClick={action.onClick}>
      {content}
    </button>
  );
}

export function QuickActionsWidget() {
  const { openPaletteInChatMode } = useAssistant();

  const actions: Action[] = [
    {
      label: "Ask Assistant",
      description: "Natural language control",
      icon: Message01Icon,
      onClick: () => openPaletteInChatMode(),
    },
    {
      label: "App Store",
      description: "Browse & install apps",
      icon: DownloadSquare01Icon,
      href: "/dashboard/apps",
    },
    {
      label: "Services",
      description: "Manage containers",
      icon: Package01Icon,
      href: "/dashboard/containers",
    },
    {
      label: "Intelligence",
      description: "Activity & insights",
      icon: Activity01Icon,
      href: "/dashboard/intelligence",
    },
  ];

  return (
    <Widget>
      <WidgetHeader title="Quick Actions" />
      {/* 2×2 grid — borders via box-shadow on cells to avoid border-collapse issues */}
      <div className="grid grid-cols-2">
        {actions.map((action, i) => (
          <div
            key={action.label}
            className={cn(
              "relative",
              // Right border on left column
              i % 2 === 0 && "border-r border-border/40",
              // Top border on bottom row
              i >= 2 && "border-t border-border/40"
            )}
          >
            <ActionTile action={action} />
          </div>
        ))}
      </div>
    </Widget>
  );
}
