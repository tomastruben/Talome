"use client"

import { useTheme } from "next-themes"
import { Toaster as Sonner, type ToasterProps } from "sonner"
import {
  HugeiconsIcon,
  CheckmarkCircle01Icon,
  InformationCircleIcon,
  AlertCircleIcon,
} from "@/components/icons"

const Toaster = ({ ...props }: ToasterProps) => {
  const { theme = "system" } = useTheme()

  return (
    <Sonner
      theme={theme as ToasterProps["theme"]}
      className="toaster group"
      closeButton
      icons={{
        success: <HugeiconsIcon icon={CheckmarkCircle01Icon} size={15} strokeWidth={1.5} />,
        info:    <HugeiconsIcon icon={InformationCircleIcon} size={15} strokeWidth={1.5} />,
        warning: <HugeiconsIcon icon={AlertCircleIcon}       size={15} strokeWidth={1.5} />,
        error:   <HugeiconsIcon icon={AlertCircleIcon}       size={15} strokeWidth={1.5} />,
      }}
      style={
        {
          "--normal-bg":     "var(--popover)",
          "--normal-text":   "var(--popover-foreground)",
          "--normal-border": "var(--border)",
          "--border-radius": "var(--radius)",
        } as React.CSSProperties
      }
      {...props}
    />
  )
}

export { Toaster }
