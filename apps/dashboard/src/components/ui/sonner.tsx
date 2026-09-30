"use client"

import { usePathname } from "next/navigation"
import { useTheme } from "next-themes"
import { Toaster as Sonner, toast, type ToasterProps } from "sonner"
import {
  HugeiconsIcon,
  InformationCircleIcon,
  Alert02Icon,
  AlertCircleIcon,
} from "@/components/icons"
import { Spinner } from "@/components/ui/spinner"
import { SuccessCheck } from "@/components/ui/micro"
import { TOAST_DURATION, toastWarning } from "@/lib/toast"

/** Clears the desktop-mode dock (dock height plus its bottom gap). */
const DESKTOP_TOAST_OFFSET = { bottom: 88, left: 16 } as const
const DEFAULT_TOAST_OFFSET = 16

/**
 * Status icons. The toast surface stays neutral; only the icon carries
 * status colour. Warning and error use different glyphs so they are never
 * distinguished by colour alone.
 */
export const toastIcons = {
  // The check draws itself as the toast arrives (static under reduced motion).
  success: (
    <span className="inline-flex text-status-healthy" data-toast-icon="success">
      <SuccessCheck size={16} />
    </span>
  ),
  info: (
    <HugeiconsIcon
      icon={InformationCircleIcon}
      size={16}
      strokeWidth={1.5}
      className="text-muted-foreground"
      data-toast-icon="info"
    />
  ),
  warning: (
    <HugeiconsIcon
      icon={Alert02Icon}
      size={16}
      strokeWidth={1.5}
      className="text-status-warning"
      data-toast-icon="warning"
    />
  ),
  error: (
    <HugeiconsIcon
      icon={AlertCircleIcon}
      size={16}
      strokeWidth={1.5}
      className="text-status-critical"
      data-toast-icon="error"
    />
  ),
  loading: <Spinner decorative className="text-muted-foreground" />,
}

/**
 * Mounted by the root layout (app/layout.tsx). Neutral `--surface-toast`
 * background, `rounded-lg`, `shadow-lg`, no rich colours.
 *
 * Not yet top-level only: every desktop-window iframe loads the same root
 * layout, so each window still has its own Toaster until the iframe toast
 * bridge lands (spec §4.7). Sonner has no per-type duration, so the default
 * here is the success/info 4s; warnings go through `toastWarning()` (6s).
 */
const Toaster = ({ ...props }: ToasterProps) => {
  const { theme = "system" } = useTheme()
  const pathname = usePathname()
  const desktop = pathname === "/dashboard/desktop"

  return (
    <Sonner
      theme={theme as ToasterProps["theme"]}
      className="toaster group"
      position="bottom-left"
      offset={desktop ? DESKTOP_TOAST_OFFSET : DEFAULT_TOAST_OFFSET}
      visibleToasts={3}
      closeButton
      icons={toastIcons}
      duration={TOAST_DURATION.success}
      style={
        {
          "--normal-bg": "var(--surface-toast)",
          "--normal-text": "var(--foreground)",
          "--normal-border": "var(--border)",
          "--border-radius": "var(--radius-lg)",
        } as React.CSSProperties
      }
      {...props}
    />
  )
}

type Messages<T> = {
  /** Present participle plus object, with "…": "Installing Jellyfin…" */
  loading: string
  /** The receipt. Fires only when `run` resolves, which must mean the server verified the result. */
  success: string | ((result: T) => string)
  /** What failed and the fix: "Couldn't install Jellyfin: port 8096 is already in use." */
  error: string | ((error: unknown) => string)
  /** Optional description under the success line. */
  successDescription?: string | ((result: T) => string)
}

interface PromiseToastOptions<T> extends Messages<T> {
  /** An action on the success toast, such as "Open". */
  successAction?: { label: string; onClick: () => void }
  /** Retry the operation from the error toast. */
  onRetry?: () => void
  /** A second action on the error toast, such as "Ask Talome". */
  errorAction?: { label: string; onClick: () => void }
}

/**
 * Tracks a long operation (install, update, backup, restore, deploy,
 * upload, agent-started job) in one toast: loading, then a receipt or an
 * error that names the fix. The promise must resolve only once the server
 * reports a verified state, never on the HTTP 200 of the request that
 * started the job.
 *
 * Error toasts that carry an action stay until they are dismissed.
 * Returns the operation's promise so callers can still await the result.
 */
function promiseToast<T>(run: Promise<T> | (() => Promise<T>), options: PromiseToastOptions<T>): Promise<T> {
  const promise = typeof run === "function" ? run() : run
  const id = toast.loading(options.loading)

  promise.then(
    (result) => {
      const message = typeof options.success === "function" ? options.success(result) : options.success
      const description =
        typeof options.successDescription === "function"
          ? options.successDescription(result)
          : options.successDescription
      toast.success(message, {
        id,
        description,
        duration: TOAST_DURATION.success,
        action: options.successAction,
      })
    },
    (error: unknown) => {
      const message = typeof options.error === "function" ? options.error(error) : options.error
      const hasAction = Boolean(options.onRetry || options.errorAction)
      toast.error(message, {
        id,
        duration: hasAction ? Infinity : TOAST_DURATION.warning,
        action: options.onRetry ? { label: "Retry", onClick: options.onRetry } : options.errorAction,
        cancel: options.onRetry && options.errorAction ? options.errorAction : undefined,
      })
    },
  )

  return promise
}

export { Toaster, promiseToast, toastWarning, TOAST_DURATION }
