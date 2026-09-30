"use client"

import * as React from "react"

import { HugeiconsIcon } from "@/components/icons"
import type { IconSvgElement } from "@/components/icons"
import { cn } from "@/lib/utils"

export interface RadioCardOption<T extends string> {
  value: T
  title: string
  description: string
  icon?: IconSvgElement
  /** A neutral badge such as "Recommended". */
  badge?: string
  disabled?: boolean
  /** Shown instead of the description's hint when disabled; also the accessible reason. */
  disabledReason?: string
}

export interface RadioCardGroupProps<T extends string> {
  value: T | undefined
  /**
   * Called when a card is chosen. A choice that widens privilege must not
   * apply here directly: open a `destructive` confirm first (useConfirm).
   */
  onValueChange: (value: T) => void
  options: readonly RadioCardOption<T>[]
  /** Required: names the choice for assistive technology ("Security mode"). */
  "aria-label"?: string
  "aria-labelledby"?: string
  columns?: 1 | 2 | 3
  disabled?: boolean
  /**
   * "automatic" (default): arrow keys move and select, as a plain radio group.
   * "manual": arrow keys only move focus; Space, Enter or a click selects. Use
   * it when choosing has a side effect (a server-wide setting), so moving
   * through the options never applies one.
   */
  activation?: "automatic" | "manual"
  className?: string
}

const COLUMN_CLASS: Record<1 | 2 | 3, string> = {
  1: "grid-cols-1",
  2: "grid-cols-1 sm:grid-cols-2",
  3: "grid-cols-1 sm:grid-cols-3",
}

/**
 * Next enabled index from `from` in `direction`, wrapping around. Returns
 * `from` when every other option is disabled. Exported for tests.
 */
export function nextEnabledIndex(
  disabled: readonly boolean[],
  from: number,
  direction: 1 | -1,
): number {
  const n = disabled.length
  if (n === 0) return -1
  for (let step = 1; step <= n; step++) {
    const i = (((from + direction * step) % n) + n) % n
    if (!disabled[i]) return i
  }
  return from
}

/**
 * A single choice shown as cards. `role="radiogroup"` with roving tabIndex:
 * Tab enters on the selected card, arrow keys move (and select, unless
 * `activation="manual"`), Space and Enter select, Home and End jump to the ends.
 */
function RadioCardGroup<T extends string>({
  value,
  onValueChange,
  options,
  columns = 1,
  disabled = false,
  activation = "automatic",
  className,
  ...aria
}: RadioCardGroupProps<T>) {
  const idPrefix = React.useId()
  const refs = React.useRef<Array<HTMLButtonElement | null>>([])
  const isDisabled = options.map((option) => disabled || Boolean(option.disabled))
  const selectedIndex = options.findIndex((option) => option.value === value)
  const firstEnabled = isDisabled.findIndex((d) => !d)
  // Manual activation: the roving tab stop follows focus, not the selection.
  const [focusedIndex, setFocusedIndex] = React.useState<number | null>(null)
  const tabStop =
    activation === "manual" && focusedIndex !== null && !isDisabled[focusedIndex]
      ? focusedIndex
      : selectedIndex >= 0 && !isDisabled[selectedIndex]
        ? selectedIndex
        : firstEnabled

  const move = (index: number) => {
    if (!options[index] || isDisabled[index]) return
    setFocusedIndex(index)
    refs.current[index]?.focus()
  }

  const select = (index: number) => {
    const option = options[index]
    if (!option || isDisabled[index]) return
    refs.current[index]?.focus()
    if (option.value !== value) onValueChange(option.value)
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    let target: number | null = null
    switch (event.key) {
      case "ArrowDown":
      case "ArrowRight":
        target = nextEnabledIndex(isDisabled, index, 1)
        break
      case "ArrowUp":
      case "ArrowLeft":
        target = nextEnabledIndex(isDisabled, index, -1)
        break
      case "Home":
        target = isDisabled.findIndex((d) => !d)
        break
      case "End": {
        const lastEnabled = [...isDisabled].reverse().findIndex((d) => !d)
        target = lastEnabled === -1 ? -1 : options.length - 1 - lastEnabled
        break
      }
      case " ":
      case "Enter":
        event.preventDefault()
        select(index)
        return
      default:
        return
    }
    event.preventDefault()
    if (target === null || target < 0) return
    if (activation === "manual") move(target)
    else select(target)
  }

  return (
    <div
      role="radiogroup"
      aria-disabled={disabled || undefined}
      data-slot="radio-card-group"
      className={cn("grid gap-2", COLUMN_CLASS[columns], className)}
      onBlur={(event) => {
        // Leaving the group: Tab comes back in on the selected card.
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocusedIndex(null)
      }}
      {...aria}
    >
      {options.map((option, index) => {
        const checked = option.value === value
        const optionDisabled = isDisabled[index]
        const descriptionId = `${idPrefix}-${index}-description`
        return (
          <button
            key={option.value}
            ref={(el) => {
              refs.current[index] = el
            }}
            type="button"
            role="radio"
            aria-checked={checked}
            aria-disabled={optionDisabled || undefined}
            aria-describedby={descriptionId}
            tabIndex={index === tabStop ? 0 : -1}
            data-state={checked ? "checked" : "unchecked"}
            data-slot="radio-card"
            onClick={() => select(index)}
            onFocus={() => setFocusedIndex(index)}
            onKeyDown={(event) => onKeyDown(event, index)}
            className={cn(
              "group/radio-card relative flex w-full items-start gap-3 rounded-xl border p-4 text-left",
              "transition-[background-color,border-color] duration-150 ease-out",
              "outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
              checked ? "border-foreground/60 bg-muted/40" : "border-border hover:bg-muted/30",
              optionDisabled && "cursor-not-allowed opacity-50 hover:bg-transparent",
            )}
          >
            {option.icon ? (
              <HugeiconsIcon
                icon={option.icon}
                size={16}
                strokeWidth={1.5}
                aria-hidden="true"
                className={cn("mt-0.5 shrink-0", checked ? "text-foreground" : "text-muted-foreground")}
              />
            ) : null}
            <span className="flex min-w-0 flex-1 flex-col gap-1">
              <span className="flex items-center gap-2">
                <span className="text-sm font-medium text-foreground">{option.title}</span>
                {option.badge ? (
                  <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                    {option.badge}
                  </span>
                ) : null}
              </span>
              <span id={descriptionId} className="text-xs text-muted-foreground">
                {optionDisabled && option.disabledReason ? option.disabledReason : option.description}
              </span>
            </span>
            {/* Selection indicator: a ring, filled when checked. Shape, not only colour. */}
            <span
              aria-hidden="true"
              className={cn(
                "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border",
                checked ? "border-foreground" : "border-muted-foreground",
              )}
            >
              <span
                className={cn(
                  "size-2 rounded-full bg-foreground transition-opacity duration-150 ease-out",
                  checked ? "opacity-100" : "opacity-0",
                )}
              />
            </span>
          </button>
        )
      })}
    </div>
  )
}

export { RadioCardGroup }
