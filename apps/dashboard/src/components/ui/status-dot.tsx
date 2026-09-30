import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * The status grammar. A static dot is a state; a breathing info dot is work
 * in flight; "needs you" is never a dot but an amber count (Badge
 * variant="count"). Colour is never the only signal, so the label is always
 * rendered: visibly, or `sr-only` in dense chrome (pair it with a tooltip).
 */
export type StatusDotState = "healthy" | "stopped" | "working" | "failed" | "unknown"

const STATE_CLASS: Record<StatusDotState, string> = {
  healthy: "bg-status-healthy",
  // Stopped by a person is not a failure: grey, not red.
  stopped: "bg-muted-foreground/40",
  working: "bg-status-info motion-safe:animate-breathe",
  failed: "bg-status-critical",
  // Hollow: health not reported, SMART unavailable.
  unknown: "bg-transparent ring-1 ring-inset ring-muted-foreground",
}

const SIZE_CLASS = {
  sm: "size-1.5",
  md: "size-2",
} as const

export interface StatusDotProps extends Omit<React.ComponentProps<"span">, "children"> {
  state: StatusDotState
  label: string
  /** `sm` (6px) for nav and dock, `md` (8px) for lists and tables. */
  size?: keyof typeof SIZE_CLASS
  /** Keep the label for screen readers only (dense chrome). */
  hideLabel?: boolean
}

function StatusDot({ state, label, size = "md", hideLabel = false, className, ...props }: StatusDotProps) {
  return (
    <span
      data-slot="status-dot"
      data-state={state}
      className={cn("inline-flex items-center gap-2", className)}
      {...props}
    >
      <span aria-hidden="true" className={cn("shrink-0 rounded-full", SIZE_CLASS[size], STATE_CLASS[state])} />
      <span className={hideLabel ? "sr-only" : "text-sm text-foreground"}>{label}</span>
    </span>
  )
}

export { StatusDot }
