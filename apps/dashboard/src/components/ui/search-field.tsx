"use client"

import * as React from "react"
import { HugeiconsIcon, Search01Icon, Cancel01Icon } from "@/components/icons"
import { cn } from "@/lib/utils"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"

interface SearchFieldProps extends React.ComponentProps<"input"> {
  containerClassName?: string
}

function SearchField({ containerClassName, className, ref, onKeyDown, ...props }: SearchFieldProps) {
  const [expanded, setExpanded] = React.useState(false)
  const inputRef = React.useRef<HTMLInputElement | null>(null)
  const toggleRef = React.useRef<HTMLButtonElement | null>(null)
  const closeRef = React.useRef<HTMLButtonElement | null>(null)
  const label = props["aria-label"] ?? props.placeholder ?? "Search"
  const query = String(props.value ?? "")

  const collapse = () => {
    setExpanded(false)
    requestAnimationFrame(() => toggleRef.current?.focus())
  }

  React.useEffect(() => {
    if (expanded) inputRef.current?.focus()
  }, [expanded])

  return (
    <div
      className={cn("search-field", containerClassName)}
      data-search-expanded={expanded || undefined}
    >
      <HugeiconsIcon
        icon={Search01Icon}
        size={15}
        className="search-field-icon"
        aria-hidden="true"
      />
      <Input
        className={cn("rounded-full border-border/50 pl-9 transition-[color,border-color,box-shadow] duration-150 ease-out hover:border-border focus-visible:border-ring contrast-more:border-input", className)}
        {...props}
        ref={(node) => {
          inputRef.current = node
          if (typeof ref === "function") return ref(node)
          if (ref) ref.current = node
        }}
        onKeyDown={(event) => {
          onKeyDown?.(event)
          // Outside a compact window the close control is hidden, and Escape
          // continues to belong to the page. Collapsing never clears a query.
          if (event.key === "Escape" && !event.defaultPrevented && closeRef.current?.getClientRects().length) {
            event.preventDefault()
            event.stopPropagation()
            collapse()
          }
        }}
      />
      <Button
        ref={toggleRef}
        className="search-field-toggle"
        variant={query ? "secondary" : "outline"}
        size="icon-sm"
        aria-label={query ? `${label}, filtered by ${query}` : label}
        title={query ? `${label}: ${query}` : label}
        aria-expanded={expanded}
        disabled={props.disabled}
        onClick={() => setExpanded(true)}
      >
        <HugeiconsIcon icon={Search01Icon} size={15} aria-hidden="true" />
      </Button>
      <Button
        ref={closeRef}
        className="search-field-close"
        variant="ghost"
        size="icon-sm"
        aria-label="Collapse search"
        title="Collapse search"
        onClick={collapse}
      >
        <HugeiconsIcon icon={Cancel01Icon} size={15} aria-hidden="true" />
      </Button>
    </div>
  )
}

export { SearchField }
