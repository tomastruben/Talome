"use client"

import * as React from "react"

/**
 * One polite and one assertive live region for the whole app, mounted once
 * in the top-level document. Desktop windows are iframes running the same
 * layout, so inside a window `announce()` forwards to the top-level page
 * (same origin) instead of speaking through a region of its own.
 *
 * Use for events a screen-reader user would otherwise miss: an approval
 * arriving, a job phase changing, a chat reply finishing. Toasts use
 * Sonner's own region; form errors use role="alert" in place.
 */

export const ANNOUNCE_MESSAGE_TYPE = "talome:announce"

type Politeness = "polite" | "assertive"
type Listener = (message: string, politeness: Politeness) => void

const listeners = new Set<Listener>()

function isEmbedded(): boolean {
  try {
    return typeof window !== "undefined" && window.self !== window.top
  } catch {
    // Cross-origin parent: treat as embedded but unreachable.
    return true
  }
}

export function announce(message: string, options: { assertive?: boolean } = {}) {
  const politeness: Politeness = options.assertive ? "assertive" : "polite"
  if (!message || typeof window === "undefined") return
  if (isEmbedded()) {
    try {
      window.parent.postMessage({ type: ANNOUNCE_MESSAGE_TYPE, message, politeness }, window.location.origin)
    } catch {
      // Parent unreachable; nothing to announce through.
    }
    return
  }
  listeners.forEach((listener) => listener(message, politeness))
}

/** Clears a region, then sets the text on the next frame, so a repeated message is spoken again. */
function useRegion() {
  const [text, setText] = React.useState("")
  const frame = React.useRef<number | null>(null)
  const say = React.useCallback((message: string) => {
    setText("")
    if (frame.current !== null) cancelAnimationFrame(frame.current)
    frame.current = requestAnimationFrame(() => setText(message))
  }, [])
  React.useEffect(() => () => {
    if (frame.current !== null) cancelAnimationFrame(frame.current)
  }, [])
  return [text, say] as const
}

export function LiveAnnouncer() {
  const [polite, sayPolite] = useRegion()
  const [assertive, sayAssertive] = useRegion()
  const [embedded, setEmbedded] = React.useState(true)

  React.useEffect(() => {
    const inFrame = isEmbedded()
    setEmbedded(inFrame)
    if (inFrame) return

    const listener: Listener = (message, politeness) => {
      if (politeness === "assertive") sayAssertive(message)
      else sayPolite(message)
    }
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return
      const data = event.data as { type?: unknown; message?: unknown; politeness?: unknown } | null
      if (!data || data.type !== ANNOUNCE_MESSAGE_TYPE || typeof data.message !== "string") return
      listener(data.message, data.politeness === "assertive" ? "assertive" : "polite")
    }
    listeners.add(listener)
    window.addEventListener("message", onMessage)
    return () => {
      listeners.delete(listener)
      window.removeEventListener("message", onMessage)
    }
  }, [sayAssertive, sayPolite])

  if (embedded) return null
  return (
    <div data-slot="live-announcer" className="sr-only">
      <div role="status" aria-live="polite" aria-atomic="true">
        {polite}
      </div>
      <div role="alert" aria-live="assertive" aria-atomic="true">
        {assertive}
      </div>
    </div>
  )
}
