import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { Slot } from "radix-ui"

import { Spinner } from "@/components/ui/spinner"
import { cn } from "@/lib/utils"

/**
 * Focus ring recipe shared by every interactive primitive: full-opacity ring
 * with an offset, so it reads at 3:1 on any surface.
 */
export const FOCUS_RING =
  "outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
/** Inset variant for tight chrome: menu bar, dock, titlebar, list rows, table cells. */
export const FOCUS_RING_INSET = "outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"

const buttonVariants = cva(
  // `pressable` (globals.css) owns the transition: colours 150ms, press
  // scale 0.98 over 100ms, and no scale under reduced motion.
  `pressable inline-flex shrink-0 items-center justify-center gap-2 rounded-md text-sm font-medium whitespace-nowrap ${FOCUS_RING} disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4`,
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/90",
        destructive:
          "bg-destructive text-destructive-foreground hover:bg-destructive/90 dark:bg-destructive/60 dark:hover:bg-destructive/70",
        outline:
          "border bg-background shadow-xs hover:bg-accent hover:text-accent-foreground dark:border-input dark:bg-input/30 dark:hover:bg-input/50",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-secondary/80",
        ghost:
          "hover:bg-accent hover:text-accent-foreground dark:hover:bg-accent/50",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-9 px-4 py-2 has-[>svg]:px-3",
        xs: "h-6 gap-1 rounded-md px-2 text-xs has-[>svg]:px-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-8 gap-1.5 rounded-md px-3 has-[>svg]:px-2.5",
        lg: "h-10 rounded-md px-6 has-[>svg]:px-4",
        icon: "size-9",
        "icon-xs": "size-6 rounded-md [&_svg:not([class*='size-'])]:size-3",
        "icon-sm": "size-8",
        "icon-lg": "size-10",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

type ButtonProps = React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
    /**
     * The action is running. The button keeps focus and width, ignores
     * clicks, and (after BUSY_DELAY_MS, so fast work never flashes) swaps its
     * label for a centred spinner. Passing `busy` (true or false) opts the
     * button into the busy layout; leave it undefined for a plain button.
     */
    busy?: boolean
    /** Screen-reader name while busy, e.g. "Installing Jellyfin…". */
    busyLabel?: string
  }

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  busy,
  busyLabel,
  children,
  onClick,
  ...props
}: ButtonProps) {
  const busyCapable = busy !== undefined && !asChild
  const isBusy = busyCapable && busy === true
  const Comp = asChild ? Slot.Root : "button"

  const handleClick = React.useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      if (isBusy) {
        event.preventDefault()
        event.stopPropagation()
        return
      }
      onClick?.(event)
    },
    [isBusy, onClick],
  )

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      data-busy={isBusy ? "true" : undefined}
      className={cn(buttonVariants({ variant, size }), busyCapable && "relative", className)}
      onClick={busyCapable ? handleClick : onClick}
      {...(isBusy
        ? {
            "aria-busy": true,
            "aria-disabled": true,
            ...(busyLabel ? { "aria-label": busyLabel } : {}),
          }
        : {})}
      {...props}
    >
      {busyCapable ? (
        <>
          {/* Label stays in the DOM so the width never changes. Opacity
              switches after BUSY_DELAY_MS (150ms) via transition-delay. */}
          <span
            data-slot="button-label"
            className={cn(
              "inline-flex items-center justify-center gap-[inherit] transition-opacity",
              isBusy ? "opacity-0 delay-150 duration-120" : "opacity-100 duration-120",
            )}
          >
            {children}
          </span>
          <span
            data-slot="button-spinner"
            aria-hidden="true"
            className={cn(
              "pointer-events-none absolute inset-0 flex items-center justify-center transition-opacity",
              isBusy ? "opacity-100 delay-150 duration-120" : "opacity-0 duration-120",
            )}
          >
            {isBusy ? <Spinner decorative /> : null}
          </span>
        </>
      ) : (
        children
      )}
    </Comp>
  )
}

export { Button, buttonVariants }
export type { ButtonProps }
