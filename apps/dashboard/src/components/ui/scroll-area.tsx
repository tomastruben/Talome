"use client"

import * as React from "react"
import { ScrollArea as ScrollAreaPrimitive } from "radix-ui"

import { cn } from "@/lib/utils"

export type EdgeFadeState = { top: boolean; bottom: boolean; left: boolean; right: boolean }

/**
 * Which edges of a scroller have more content beyond them. A 1px tolerance
 * absorbs sub-pixel rounding, so a list scrolled to the end shows no fade.
 */
export function edgeFadeState(el: {
  scrollTop: number
  scrollLeft: number
  scrollHeight: number
  scrollWidth: number
  clientHeight: number
  clientWidth: number
}): EdgeFadeState {
  return {
    top: el.scrollTop > 1,
    bottom: el.scrollTop + el.clientHeight < el.scrollHeight - 1,
    left: el.scrollLeft > 1,
    right: el.scrollLeft + el.clientWidth < el.scrollWidth - 1,
  }
}

function applyEdgeFade(el: HTMLElement) {
  const state = edgeFadeState(el)
  el.dataset.fadeTop = String(state.top)
  el.dataset.fadeBottom = String(state.bottom)
  el.dataset.fadeLeft = String(state.left)
  el.dataset.fadeRight = String(state.right)
}

/**
 * Keeps the `data-fade-*` attributes of a scrolling element in sync with its
 * overflow, for the `.edge-fade` mask in globals.css. Writes attributes
 * directly, so scrolling never re-renders React.
 */
export function useEdgeFade(ref: React.RefObject<HTMLElement | null>, enabled = true) {
  React.useEffect(() => {
    const el = ref.current
    if (!el || !enabled) return
    const update = () => applyEdgeFade(el)
    update()
    el.addEventListener("scroll", update, { passive: true })
    let observer: ResizeObserver | undefined
    if (typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(update)
      observer.observe(el)
      if (el.firstElementChild) observer.observe(el.firstElementChild)
    }
    return () => {
      el.removeEventListener("scroll", update)
      observer?.disconnect()
    }
  }, [ref, enabled])
}

function ScrollArea({
  className,
  children,
  fadeEdges = true,
  ...props
}: React.ComponentProps<typeof ScrollAreaPrimitive.Root> & {
  /** A 16px mask on the edges that have more content. On by default. */
  fadeEdges?: boolean
}) {
  const viewportRef = React.useRef<HTMLDivElement>(null)
  useEdgeFade(viewportRef, fadeEdges)

  return (
    <ScrollAreaPrimitive.Root
      data-slot="scroll-area"
      className={cn("relative", className)}
      {...props}
    >
      <ScrollAreaPrimitive.Viewport
        ref={viewportRef}
        data-slot="scroll-area-viewport"
        className={cn(
          "size-full rounded-[inherit] [&>div]:!block transition-[color,box-shadow] outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
          fadeEdges && "edge-fade"
        )}
      >
        {children}
      </ScrollAreaPrimitive.Viewport>
      <ScrollBar />
      <ScrollAreaPrimitive.Corner />
    </ScrollAreaPrimitive.Root>
  )
}

function ScrollBar({
  className,
  orientation = "vertical",
  ...props
}: React.ComponentProps<typeof ScrollAreaPrimitive.ScrollAreaScrollbar>) {
  return (
    <ScrollAreaPrimitive.ScrollAreaScrollbar
      data-slot="scroll-area-scrollbar"
      orientation={orientation}
      className={cn(
        "flex touch-none p-px transition-colors select-none",
        orientation === "vertical" &&
          "h-full w-2.5 border-l border-l-transparent",
        orientation === "horizontal" &&
          "h-2.5 flex-col border-t border-t-transparent",
        className
      )}
      {...props}
    >
      <ScrollAreaPrimitive.ScrollAreaThumb
        data-slot="scroll-area-thumb"
        className="relative flex-1 rounded-full bg-border"
      />
    </ScrollAreaPrimitive.ScrollAreaScrollbar>
  )
}

export { ScrollArea, ScrollBar }
