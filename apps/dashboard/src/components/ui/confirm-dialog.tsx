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

/** Normalises a thrown value or a `{ ok: false, error }` result into a message, or null on success. */
export function confirmRunError(outcome: { ok: true; value: unknown } | { ok: false; error: unknown }): string | null {
  if (outcome.ok) {
    const value = outcome.value
    if (value && typeof value === "object" && "ok" in value && (value as { ok: unknown }).ok === false) {
      const error = (value as { error?: unknown }).error
      return typeof error === "string" && error ? error : "That didn't work. Try again."
    }
    return null
  }
  const error = outcome.error
  if (error instanceof Error && error.message) return error.message
  if (typeof error === "string" && error) return error
  return "That didn't work. Try again."
}

export type ConfirmDialogProps<R = unknown> = ConfirmOptions<R> & {
  open: boolean
  /** Called with the outcome when the dialog closes (confirmed, cancelled, or dismissed). */
  onResult: (result: ConfirmResult) => void
  cancelLabel?: string
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
    const message = confirmRunError(outcome)
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
        className="gap-4 sm:max-w-md"
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
          <DialogDescription className="text-sm text-foreground">{consequence}</DialogDescription>
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
            variant="outline"
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
}

type Listener = () => void

/** A tiny queue shared by `useConfirm()` callers and the one mounted host. */
function createConfirmStore() {
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
      if (hosts === 0) {
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
    settle(id: number, result: ConfirmResult) {
      const entry = queue.find((item) => item.id === id)
      queue = queue.filter((item) => item.id !== id)
      entry?.resolve(result)
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

/** Renders the dialog for `useConfirm()` requests, one at a time. Mount once. */
export function ConfirmDialogHost() {
  const pending = React.useSyncExternalStore(confirmStore.subscribe, confirmStore.current, () => null)
  React.useEffect(() => confirmStore.registerHost(), [])

  if (!pending) return null
  return (
    <ConfirmDialog
      key={pending.id}
      open
      {...pending.options}
      onResult={(result) => confirmStore.settle(pending.id, result)}
    />
  )
}
