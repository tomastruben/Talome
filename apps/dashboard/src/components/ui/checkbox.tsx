"use client"

import * as React from "react"
import { Checkbox as CheckboxPrimitive } from "radix-ui"

import { HugeiconsIcon, Tick02Icon, MinusSignIcon } from "@/components/icons"
import { cn } from "@/lib/utils"

/**
 * A 16px checkbox with a 3:1 border in both themes. Always pair it with a
 * visible label: wrap both in `CheckboxField`, or use `<Label htmlFor>`.
 * `checked="indeterminate"` renders a dash (use it for "Select all" over a
 * partial selection).
 */
function Checkbox({ className, ...props }: React.ComponentProps<typeof CheckboxPrimitive.Root>) {
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      className={cn(
        "peer inline-flex size-4 shrink-0 items-center justify-center rounded-sm border border-muted-foreground bg-transparent text-primary-foreground",
        "transition-[background-color,border-color] duration-150 ease-out",
        "outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
        "data-[state=checked]:border-primary data-[state=checked]:bg-primary",
        "data-[state=indeterminate]:border-primary data-[state=indeterminate]:bg-primary",
        "disabled:cursor-not-allowed disabled:opacity-50",
        "aria-invalid:border-destructive",
        className,
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator
        data-slot="checkbox-indicator"
        className="group/indicator flex items-center justify-center text-current"
      >
        <HugeiconsIcon
          icon={Tick02Icon}
          size={12}
          strokeWidth={2}
          aria-hidden="true"
          className="hidden group-data-[state=checked]/indicator:block"
        />
        <HugeiconsIcon
          icon={MinusSignIcon}
          size={12}
          strokeWidth={2}
          aria-hidden="true"
          className="hidden group-data-[state=indeterminate]/indicator:block"
        />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  )
}

/**
 * Checkbox plus its label as one hit area: at least 24px tall, 44px on
 * coarse pointers. The optional description sits under the label.
 */
function CheckboxField({
  label,
  description,
  className,
  id,
  ...props
}: React.ComponentProps<typeof CheckboxPrimitive.Root> & {
  label: React.ReactNode
  description?: React.ReactNode
}) {
  const generatedId = React.useId()
  const checkboxId = id ?? generatedId
  const labelId = `${checkboxId}-label`
  const descriptionId = description ? `${checkboxId}-description` : undefined

  return (
    <label
      data-slot="checkbox-field"
      htmlFor={checkboxId}
      className={cn(
        "flex min-h-6 cursor-pointer items-start gap-2 select-none pointer-coarse:min-h-11 pointer-coarse:items-center",
        props.disabled && "cursor-not-allowed",
        className,
      )}
    >
      <Checkbox
        id={checkboxId}
        // Name from the label text only; the description is the description.
        aria-labelledby={labelId}
        aria-describedby={descriptionId}
        className="mt-0.5 pointer-coarse:mt-0"
        {...props}
      />
      <span className={cn("flex min-w-0 flex-col gap-0.5", props.disabled && "opacity-50")}>
        <span id={labelId} className="text-sm leading-5 text-foreground">
          {label}
        </span>
        {description ? (
          <span id={descriptionId} className="text-xs text-muted-foreground">
            {description}
          </span>
        ) : null}
      </span>
    </label>
  )
}

export { Checkbox, CheckboxField }
