"use client";

import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { HugeiconsIcon, SlidersHorizontalIcon } from "@/components/icons";

export interface DesktopViewGroup {
  label: string;
  value: string;
  items: readonly { value: string; label: string }[];
  onChange: (value: string) => void;
}

/** Compact navigation retains labels and selected states without a tab rail. */
export function DesktopViewMenu({ groups, className }: { groups: readonly DesktopViewGroup[]; className?: string }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" className={className} aria-label="View options" title="View options">
          <HugeiconsIcon icon={SlidersHorizontalIcon} size={16} aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-52">
        {groups.map((group, index) => (
          <DropdownMenuGroup key={group.label}>
            {index > 0 && <DropdownMenuSeparator />}
            <DropdownMenuLabel className="text-sm font-normal text-muted-foreground">{group.label}</DropdownMenuLabel>
            <DropdownMenuRadioGroup value={group.value} onValueChange={group.onChange}>
              {group.items.map((item) => (
                <DropdownMenuRadioItem key={item.value} value={item.value}>{item.label}</DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuGroup>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
