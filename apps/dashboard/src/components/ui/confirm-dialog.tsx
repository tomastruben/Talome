"use client"

import * as React from "react"
import { toast } from "sonner"

import { HugeiconsIcon, Tick02Icon, AlertCircleIcon } from "@/components/icons"
import { Button } from "@/components/ui/button"
import { CheckboxField } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { DURATION_MS } from "@/lib/motion"
import { cn } from "@/lib/utils"

/**
 * - `soft`: reversible disruption (stop or restart an app, sign out other
 *   sessions, disable a schedule, reset a layout). Confirm is the default
 *   button, focused, and Enter confirms.
 * - `destructive`: data loss, irreversible, or widening someone's privilege
 *   (uninstall, delete, revoke, regenerate recovery codes, restore over live
 *   data, promote to admin, grant full control). Cancel is focused, so Enter
 *   never confirms by accident. Never skipped, not even in Auto mode.
 */
export type ConfirmTier = "soft" | "destructive"

export interface ConfirmOptions<R = unknown> {
  tier: ConfirmTier
  /** A question naming verb and object: "Uninstall Jellyfin?" */
  title: string
  /** What will happen, concretely. */
  consequence: string
  /** What is kept and how to undo. "This can't be undone." only when true. */
  recovery: string
  /** Set when nothing is kept (the recovery line then warns instead of reassuring). */
  irreversible?: boolean
  /** Verb plus object: "Uninstall Jellyfin". */
  confirmLabel: string
  /** Defaults to "Cancel". */
  cancelLabel?: string
  /** An option such as "Keep app data" (usually on by default). */
  option?: { label: string; defaultChecked: boolean; description?: string }
  /** Bulk or volume-level loss: the person must type this exact text first. */
  typeToConfirm?: string
  /**
   * When given, the dialog owns the busy and error state: it runs this on
   * confirm, cannot be dismissed while it runs, shows a failure inline with
   * Retry, and closes only on success. Reject (or resolve `{ ok: false,
   * error }`) to report a failure; the message should name the fix.
   */
  run?: (opts: { optionChecked: boolean }) => Promise<R>
  /** Screen-reader name while running, e.g. "Uninstalling Jellyfin…". */
  busyLabel?: string
  /** Receipt toast after `run` succeeds: "Uninstalled Jellyfin · data kept". */
  receipt?: string | ((result: R) => string)
}

export interface ConfirmResult {
  confirmed: boolean
  optionChecked: boolean
}

/**
 * The message when `run` failed without saying why. It still names the
 * action and the likeliest fix (spec §5.5: errors name the fix).
 */
export function confirmRunFallback(confirmLabel?: string): string {
  const action = confirmLabel?.trim()
  const what = action ? action.charAt(0).toLowerCase() + action.slice(1) : "finish that"
  return `Couldn't ${what}. Check that the Talome server is reachable, then retry.`
}

/** Normalises a thrown value or a `{ ok: false, error }` result into a message, or null on success. */
export function confirmRunError(
  outcome: { ok: true; value: unknown } | { ok: false; error: unknown },
  confirmLabel?: string,
): string | null {
  if (outcome.ok) {
    const value = outcome.value
    if (value && typeof value === "object" && "ok" in value && (value as { ok: unknown }).ok === false) {
      const error = (value as { error?: unknown }).error
      return typeof error === "string" && error ? error : confirmRunFallback(confirmLabel)
    }
    return null
  }
  const error = outcome.error
  if (error instanceof Error && error.message) return error.message
  if (typeof error === "string" && error) return error
  return confirmRunFallback(confirmLabel)
}

export type ConfirmDialogProps<R = unknown> = ConfirmOptions<R> & {
  open: boolean
  /** Called with the outcome when the dialog closes (confirmed, cancelled, or dismissed). */
  onResult: (result: ConfirmResult) => void
}

/**
 * The confirmation dialog. Most callers use `useConfirm()` with the one
 * `<ConfirmDialogHost />`; render this directly only when a page needs a
 * controlled dialog of its own.
 */
export function ConfirmDialog<R = unknown>({
  open,
  onResult,
  tier,
  title,
  consequence,
  recovery,
  irreversible = false,
  confirmLabel,
  cancelLabel = "Cancel",
  option,
  typeToConfirm,
  run,
  busyLabel,
  receipt,
}: ConfirmDialogProps<R>) {
  const destructive = tier === "destructive"
  const [optionChecked, setOptionChecked] = React.useState(option?.defaultChecked ?? false)
  const [typed, setTyped] = React.useState("")
  const [running, setRunning] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const confirmRef = React.useRef<HTMLButtonElement>(null)
  const cancelRef = React.useRef<HTMLButtonElement>(null)
  const typeInputRef = React.useRef<HTMLInputElement>(null)
  const ids = React.useId()
  const typeInputId = `${ids}-type`
  const errorId = `${ids}-error`

  // Reset per opening.
  React.useEffect(() => {
    if (open) {
      setOptionChecked(option?.defaultChecked ?? false)
      setTyped("")
      setRunning(false)
      setError(null)
    }
  }, [open, option?.defaultChecked])

  const typedOk = !typeToConfirm || typed === typeToConfirm
  const canConfirm = typedOk && !running

  const finish = React.useCallback(
    (confirmed: boolean) => {
      onResult({ confirmed, optionChecked })
    },
    [onResult, optionChecked],
  )

  const handleConfirm = async () => {
    if (!canConfirm) return
    if (!run) {
      finish(true)
      return
    }
    setRunning(true)
    setError(null)
    let outcome: { ok: true; value: R } | { ok: false; error: unknown }
    try {
      outcome = { ok: true, value: await run({ optionChecked }) }
    } catch (err) {
      outcome = { ok: false, error: err }
    }
    const message = confirmRunError(outcome, confirmLabel)
    if (message) {
      setRunning(false)
      setError(message)
      return
    }
    setRunning(false)
    if (receipt && outcome.ok) {
      toast.success(typeof receipt === "function" ? receipt(outcome.value) : receipt)
    }
    finish(true)
  }

  const handleCancel = () => {
    if (running) return
    finish(false)
  }

  const blockWhileRunning = (event: Event) => {
    if (running) event.preventDefault()
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) handleCancel()
      }}
    >
      <DialogContent
        data-slot="confirm-dialog"
        data-tier={tier}
        role="alertdialog"
        className="gap-6 rounded-2xl sm:max-w-md"
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          if (typeToConfirm) typeInputRef.current?.focus()
          else if (destructive) cancelRef.current?.focus()
          else confirmRef.current?.focus()
        }}
        onEscapeKeyDown={blockWhileRunning}
        onPointerDownOutside={blockWhileRunning}
        onInteractOutside={blockWhileRunning}
      >
        <DialogHeader className="gap-2 text-left">
          <DialogTitle className="text-base font-medium">{title}</DialogTitle>
          {/* One description holds both lines, so the alertdialog announces the
              consequence and the recovery ("This can't be undone.") together. */}
          <DialogDescription asChild>
            <div className="flex flex-col gap-2">
              <p data-slot="confirm-consequence" className="text-sm text-foreground">{consequence}</p>
              {recovery ? (
                <p data-slot="confirm-recovery" className="flex items-start gap-2 text-sm text-muted-foreground">
                  <HugeiconsIcon
                    icon={irreversible ? AlertCircleIcon : Tick02Icon}
                    size={14}
                    strokeWidth={1.5}
                    aria-hidden="true"
                    className={cn("mt-0.5 shrink-0", irreversible ? "text-status-critical" : "text-status-healthy")}
                  />
                  <span>{recovery}</span>
                </p>
              ) : null}
            </div>
          </DialogDescription>
        </DialogHeader>

        {option ? (
          <CheckboxField
            label={option.label}
            description={option.description}
            checked={optionChecked}
            disabled={running}
            onCheckedChange={(checked) => setOptionChecked(checked === true)}
          />
        ) : null}

        {typeToConfirm ? (
          <div className="flex flex-col gap-2">
            <label htmlFor={typeInputId} className="text-sm text-foreground">
              Type <span className="font-mono">{typeToConfirm}</span> to confirm
            </label>
            <Input
              ref={typeInputRef}
              id={typeInputId}
              value={typed}
              autoComplete="off"
              spellCheck={false}
              disabled={running}
              onChange={(event) => setTyped(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && typedOk && !destructive) void handleConfirm()
              }}
            />
          </div>
        ) : null}

        {error ? (
          <p id={errorId} role="alert" className="flex items-start gap-2 text-sm text-status-critical">
            <HugeiconsIcon icon={AlertCircleIcon} size={14} strokeWidth={1.5} aria-hidden="true" className="mt-0.5 shrink-0" />
            <span>{error}</span>
          </p>
        ) : null}

        <DialogFooter className="gap-2 sm:justify-end">
          <Button
            ref={cancelRef}
            variant="ghost"
            aria-disabled={running || undefined}
            onClick={handleCancel}
          >
            {cancelLabel}
          </Button>
          <Button
            ref={confirmRef}
            variant={destructive ? "destructive" : "default"}
            busy={running}
            busyLabel={busyLabel}
            disabled={!typedOk}
            aria-describedby={error ? errorId : undefined}
            onClick={() => void handleConfirm()}
          >
            {error ? "Retry" : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ── useConfirm and the host ─────────────────────────────────────────────────

type PendingConfirm = {
  id: number
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  options: ConfirmOptions<any>
  resolve: (result: ConfirmResult) => void
  /** Decided and resolved; still mounted (closed) while the exit animation plays. */
  closing?: boolean
}

type Listener = () => void

/**
 * How long a decided dialog stays mounted (closed) so its exit animation can
 * play before the next one opens: the 140ms exit plus a frame of slack.
 */
export const CONFIRM_EXIT_MS = DURATION_MS.exit + 20

/**
 * A tiny queue of confirmations and the host that renders them. The global
 * one backs `useConfirm()`; `useConfirmAction` keeps its own. `requireHost`
 * makes a request with no mounted host resolve as cancelled.
 */
export function createConfirmStore({ requireHost = true }: { requireHost?: boolean } = {}) {
  let queue: PendingConfirm[] = []
  let nextId = 1
  let hosts = 0
  const listeners = new Set<Listener>()
  const emit = () => listeners.forEach((listener) => listener())

  return {
    subscribe(listener: Listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    current(): PendingConfirm | null {
      return queue[0] ?? null
    },
    registerHost() {
      hosts += 1
      return () => {
        hosts -= 1
      }
    },
    request<R>(options: ConfirmOptions<R>): Promise<ConfirmResult> {
      if (requireHost && hosts === 0) {
        // Never proceed with an action nobody confirmed.
        if (process.env.NODE_ENV !== "production") {
          console.error("useConfirm: no <ConfirmDialogHost /> is mounted; treating as cancelled.")
        }
        return Promise.resolve({ confirmed: false, optionChecked: false })
      }
      return new Promise<ConfirmResult>((resolve) => {
        queue = [...queue, { id: nextId++, options, resolve }]
        emit()
      })
    },
    /**
     * Resolves the request right away (the caller proceeds) and marks it
     * closing; the host removes it after CONFIRM_EXIT_MS so the dialog and its
     * scrim fade out instead of disappearing.
     */
    settle(id: number, result: ConfirmResult) {
      const entry = queue.find((item) => item.id === id)
      if (!entry || entry.closing) return
      queue = queue.map((item) => (item.id === id ? { ...item, closing: true } : item))
      entry.resolve(result)
      emit()
    },
    remove(id: number) {
      queue = queue.filter((item) => item.id !== id)
      emit()
    },
    /** Test helper: cancel everything pending. */
    reset() {
      const pending = queue
      queue = []
      pending.forEach((item) => item.resolve({ confirmed: false, optionChecked: false }))
      emit()
    },
  }
}

export const confirmStore = createConfirmStore()

/**
 * Ask the person to confirm. Resolves once they decide (and, when `run` is
 * given, once it has succeeded). Requires one `<ConfirmDialogHost />`, which
 * the root layout mounts.
 *
 * ```ts
 * const confirm = useConfirm()
 * const { confirmed, optionChecked } = await confirm({
 *   tier: "destructive",
 *   title: "Uninstall Jellyfin?",
 *   consequence: "Jellyfin stops and its container is removed.",
 *   recovery: "Your media and Jellyfin settings are kept in /data/jellyfin.",
 *   confirmLabel: "Uninstall Jellyfin",
 *   option: { label: "Keep app data", defaultChecked: true },
 * })
 * ```
 */
export function useConfirm() {
  return React.useCallback(<R,>(options: ConfirmOptions<R>) => confirmStore.request(options), [])
}

type ConfirmStore = ReturnType<typeof createConfirmStore>

/** Renders a store's requests one at a time, keeping a decided one mounted while it closes. */
export function ConfirmQueue({ store }: { store: ConfirmStore }) {
  const pending = React.useSyncExternalStore(store.subscribe, store.current, () => null)
  const closingId = pending?.closing ? pending.id : null

  React.useEffect(() => {
    if (closingId === null) return
    const timer = window.setTimeout(() => store.remove(closingId), CONFIRM_EXIT_MS)
    return () => window.clearTimeout(timer)
  }, [closingId, store])

  if (!pending) return null
  return (
    <ConfirmDialog
      key={pending.id}
      open={!pending.closing}
      {...pending.options}
      onResult={(result) => store.settle(pending.id, result)}
    />
  )
}

/** Renders the dialog for `useConfirm()` requests, one at a time. Mount once. */
export function ConfirmDialogHost() {
  React.useEffect(() => confirmStore.registerHost(), [])
  return <ConfirmQueue store={confirmStore} />
}
