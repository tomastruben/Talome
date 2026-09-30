"use client"

import { useTheme } from "next-themes"
import { Toaster as Sonner, type ToasterProps } from "sonner"
import {
  HugeiconsIcon,
  InformationCircleIcon,
  AlertCircleIcon,
} from "@/components/icons"
import { SuccessCheck } from "@/components/ui/micro"

const Toaster = ({ ...props }: ToasterProps) => {
  const { theme = "system" } = useTheme()

  return (
    <Sonner
      theme={theme as ToasterProps["theme"]}
      className="toaster group"
      closeButton
      icons={{
        // The check draws itself as the toast arrives
        success: <SuccessCheck size={16} />,
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
