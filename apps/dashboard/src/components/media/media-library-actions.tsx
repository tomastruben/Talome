"use client";

import type { Ref } from "react";
import {
  HugeiconsIcon,
  Cancel01Icon,
  CheckmarkCircle02Icon,
  Projector01Icon,
} from "@/components/icons";
import { Button } from "@/components/ui/button";
import { preloadCinemaBrowser } from "@/components/media/cinema-browser-launcher";
import { cn } from "@/lib/utils";

interface MediaLibraryActionsProps {
  /**
   * "toolbar": a desktop window's toolbar row, where the labels show once the
   * content column is `@2xl` wide (named icon buttons below that).
   * "header": the classic page header, as text buttons; Cinema shows from
   * `md` up there, since phones browse the grid instead.
   */
  placement: "toolbar" | "header";
  /** Selection mode is on: the toggle reads Cancel and looks pressed. */
  selecting: boolean;
  onCinema: () => void;
  onToggleSelect: () => void;
  /** The Select toggle, so focus can return to it when the selection bar closes. */
  selectRef?: Ref<HTMLButtonElement>;
}

/**
 * The library's verbs: Cinema (the full-screen browser) and Select (pick
 * titles for the selection bar). The same two controls in a window's toolbar
 * and in the classic header, so both modes reach the same actions; a window's
 * title bar keeps only its controls, Back and the title.
 */
export function MediaLibraryActions({
  placement,
  selecting,
  onCinema,
  onToggleSelect,
  selectRef,
}: MediaLibraryActionsProps) {
  const selectLabel = selecting ? "Cancel" : "Select";

  if (placement === "header") {
    const headerClass = "h-7 gap-1.5 px-2.5 text-xs text-muted-foreground hover:text-foreground pointer-coarse:h-11";
    return (
      <>
        <Button
          variant="ghost"
          size="sm"
          className={cn("hidden md:inline-flex", headerClass)}
          onClick={onCinema}
          onPointerEnter={preloadCinemaBrowser}
          onFocus={preloadCinemaBrowser}
        >
          <HugeiconsIcon icon={Projector01Icon} size={14} aria-hidden="true" />
          Cinema
        </Button>
        <Button
          ref={selectRef}
          variant={selecting ? "secondary" : "ghost"}
          size="sm"
          className={headerClass}
          onClick={onToggleSelect}
        >
          {selectLabel}
        </Button>
      </>
    );
  }

  // Matches the Files toolbar's verbs: 32px, 44px on touch, labelled where the column has room
  const toolbarClass = "h-8 gap-1.5 px-2 text-muted-foreground hover:text-foreground pointer-coarse:h-11 pointer-coarse:min-w-11";
  const labelClass = "sr-only @2xl:not-sr-only";
  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        title="Cinema"
        className={toolbarClass}
        onClick={onCinema}
        onPointerEnter={preloadCinemaBrowser}
        onFocus={preloadCinemaBrowser}
      >
        <HugeiconsIcon icon={Projector01Icon} size={14} aria-hidden="true" />
        <span className={labelClass}>Cinema</span>
      </Button>
      <Button
        ref={selectRef}
        type="button"
        variant={selecting ? "secondary" : "ghost"}
        size="sm"
        title={selectLabel}
        className={cn(toolbarClass, selecting && "text-foreground")}
        onClick={onToggleSelect}
      >
        <HugeiconsIcon icon={selecting ? Cancel01Icon : CheckmarkCircle02Icon} size={14} aria-hidden="true" />
        <span className={labelClass}>{selectLabel}</span>
      </Button>
    </>
  );
}
