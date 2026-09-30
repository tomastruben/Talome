"use client"

import * as React from "react"

import { HugeiconsIcon, Copy01Icon, Tick02Icon } from "@/components/icons"
import { Button } from "@/components/ui/button"
import { COPY_REVERT_MS } from "@/lib/motion"
import { cn } from "@/lib/utils"

/**
 * Copies text to the clipboard. Tries the async Clipboard API first, then
 * (on plain-http LAN origins, where it is unavailable) a hidden-textarea
 * `execCommand("copy")`. Resolves true only when a copy really happened.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // Fall through to the legacy path.
  }
  if (typeof document === "undefined") return false
  const textarea = document.createElement("textarea")
  textarea.value = text
  textarea.setAttribute("readonly", "")
  textarea.style.position = "fixed"
  textarea.style.top = "0"
  textarea.style.left = "0"
  textarea.style.opacity = "0"
  textarea.style.pointerEvents = "none"
  document.body.appendChild(textarea)
  const selection = document.getSelection()
  const previousRange = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null
  try {
    textarea.select()
    textarea.setSelectionRange(0, text.length)
    return typeof document.execCommand === "function" && document.execCommand("copy") === true
  } catch {
    return false
  } finally {
    document.body.removeChild(textarea)
    if (previousRange && selection) {
      selection.removeAllRanges()
      selection.addRange(previousRange)
    }
  }
}

function selectContents(el: HTMLElement | null | undefined) {
  if (!el) return
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    el.focus()
    el.select()
    return
  }
  const selection = window.getSelection()
  if (!selection) return
  const range = document.createRange()
  range.selectNodeContents(el)
  selection.removeAllRanges()
  selection.addRange(range)
}

function isApplePlatform() {
  if (typeof navigator === "undefined") return false
  return /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent)
}

export interface CopyButtonProps
  extends Omit<React.ComponentProps<typeof Button>, "value" | "onClick" | "children" | "size" | "busy"> {
  value: string | (() => string)
  /** Accessible name: "Copy access token". */
  label: string
  /** Visible text for text sizes. Defaults to "Copy". Icon sizes show only the glyph. */
  text?: string
  size?: "xs" | "sm" | "icon-sm" | "icon-xs"
  /** The element whose text is selected if copying fails, so the person can copy by hand. */
  selectOnFailRef?: React.RefObject<HTMLElement | null>
  onCopied?: () => void
  /**
   * Called when both copy paths failed, before the text is selected (the
   * selection waits a frame, so a caller can first reveal masked text).
   */
  onCopyFailed?: () => void
}

/**
 * The one copy control. Fixed width (the label never shifts), a Copy to
 * Tick crossfade over 120ms that reverts after 2s, a polite "Copied"
 * announcement, and an inline error with the text selected when both copy
 * paths fail. Copying never produces a toast.
 */
function CopyButton({
  value,
  label,
  text = "Copy",
  size = "icon-sm",
  variant = "ghost",
  selectOnFailRef,
  onCopied,
  onCopyFailed,
  className,
  ...props
}: CopyButtonProps) {
  const [state, setState] = React.useState<"idle" | "copied" | "failed">("idle")
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  const iconOnly = size === "icon-sm" || size === "icon-xs"

  React.useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current)
  }, [])

  const handleClick = async () => {
    const resolved = typeof value === "function" ? value() : value
    const ok = await copyText(resolved)
    if (timer.current) clearTimeout(timer.current)
    if (ok) {
      setState("copied")
      onCopied?.()
      timer.current = setTimeout(() => setState("idle"), COPY_REVERT_MS)
    } else {
      setState("failed")
      if (onCopyFailed) {
        onCopyFailed()
        requestAnimationFrame(() => selectContents(selectOnFailRef?.current))
      } else {
        selectContents(selectOnFailRef?.current)
      }
    }
  }

  const copied = state === "copied"
  const glyphSize = size === "xs" || size === "icon-xs" ? 12 : 14

  return (
    <span data-slot="copy-button" className="inline-flex flex-col items-start gap-1">
      <Button
        type="button"
        variant={variant}
        size={size}
        // The name always contains the visible word ("Copy …"), per WCAG 2.5.3.
        aria-label={label}
        title={iconOnly ? label : undefined}
        data-state={state}
        onClick={() => void handleClick()}
        className={cn(!iconOnly && "justify-start", className)}
        {...props}
      >
        <span className="relative inline-flex shrink-0 items-center justify-center" aria-hidden="true">
          <HugeiconsIcon
            icon={Copy01Icon}
            size={glyphSize}
            strokeWidth={1.5}
            className={cn("transition-opacity duration-120 ease-out", copied ? "opacity-0" : "opacity-100")}
          />
          <HugeiconsIcon
            icon={Tick02Icon}
            size={glyphSize}
            strokeWidth={1.5}
            className={cn(
              "absolute inset-0 text-status-healthy transition-opacity duration-120 ease-out",
              copied ? "opacity-100" : "opacity-0",
            )}
          />
        </span>
        {iconOnly ? null : (
          // Both words occupy the same grid cell, so the width never changes.
          <span className="grid" aria-hidden="true">
            <span className={cn("col-start-1 row-start-1", copied && "invisible")}>{text}</span>
            <span className={cn("col-start-1 row-start-1", !copied && "invisible")}>
              Copied
            </span>
          </span>
        )}
      </Button>
      <span className="sr-only" aria-live="polite" role="status">
        {copied ? "Copied" : ""}
      </span>
      {state === "failed" ? (
        <span role="alert" className="text-xs text-status-critical">
          {selectOnFailRef
            ? `Couldn't copy. The text is selected, so press ${isApplePlatform() ? "⌘C" : "Ctrl+C"}.`
            : `Couldn't copy. Select the text and press ${isApplePlatform() ? "⌘C" : "Ctrl+C"}.`}
        </span>
      ) : null}
    </span>
  )
}

export { CopyButton }
