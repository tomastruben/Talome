import * as React from "react"
import { HugeiconsIcon, Search01Icon } from "@/components/icons"
import { cn } from "@/lib/utils"
import { Input } from "@/components/ui/input"

interface SearchFieldProps extends React.ComponentProps<"input"> {
  containerClassName?: string
}

function SearchField({ containerClassName, className, ...props }: SearchFieldProps) {
  return (
    <div className={cn("search-field", containerClassName)}>
      <HugeiconsIcon
        icon={Search01Icon}
        size={15}
        className="search-field-icon"
      />
      <Input className={cn("pl-9", className)} {...props} />
    </div>
  )
}

export { SearchField }
