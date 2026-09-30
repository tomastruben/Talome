import { HugeiconsIcon, Loading03Icon } from "@/components/icons"

import { cn } from "@/lib/utils"

type SpinnerProps = Omit<React.ComponentProps<typeof HugeiconsIcon>, "icon"> & {
  /**
   * Set when the spinner sits inside something that already announces the
   * busy state (a busy Button, a loading toast). It is then hidden from
   * assistive technology instead of being its own status region.
   */
  decorative?: boolean
  /** Accessible name when the spinner stands alone. */
  label?: string
}

/**
 * The one loading glyph. Rotates only while motion is allowed; under
 * reduced motion the glyph is static and the label still carries the state.
 * Use for busy buttons and inline pending work, never for page loads (use a
 * Skeleton).
 */
function Spinner({ className, decorative = false, label = "Loading", ...props }: SpinnerProps) {
  const a11y = decorative
    ? ({ "aria-hidden": true } as const)
    : ({ role: "status", "aria-label": label } as const)
  return (
    <HugeiconsIcon
      icon={Loading03Icon}
      size={16}
      strokeWidth={1.5}
      data-slot="spinner"
      {...a11y}
      className={cn("size-4 shrink-0 motion-safe:animate-spin", className)}
      {...props}
    />
  )
}

export { Spinner }
