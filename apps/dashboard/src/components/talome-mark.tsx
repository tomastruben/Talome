import { cn } from "@/lib/utils";

/**
 * The Talome mark: one copy of the logo for the sidebar, mobile nav and
 * desktop menu bar. Decorative by default; pass `title` when the mark is the
 * only thing naming its control.
 */
export function TalomeMark({ size = 18, className, title }: { size?: number; className?: string; title?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      className={cn("shrink-0", className)}
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      focusable="false"
    >
      <circle cx="12" cy="4.5" r="1.7" />
      <circle cx="17.1" cy="7" r="1.27" opacity="0.56" />
      <circle cx="12" cy="9.5" r="0.72" opacity="0.12" />
      <circle cx="6.5" cy="12" r="1.27" opacity="0.56" />
      <circle cx="12" cy="14.5" r="1.7" />
      <circle cx="17.5" cy="17" r="1.27" opacity="0.56" />
      <circle cx="12" cy="19.5" r="0.72" opacity="0.12" />
      <circle cx="12" cy="4.5" r="0.72" opacity="0.12" />
      <circle cx="6.5" cy="7" r="1.27" opacity="0.56" />
      <circle cx="12" cy="9.5" r="1.7" />
      <circle cx="17.5" cy="12" r="1.27" opacity="0.56" />
      <circle cx="12" cy="14.5" r="0.72" opacity="0.12" />
      <circle cx="6.5" cy="17" r="1.27" opacity="0.56" />
      <circle cx="12" cy="19.5" r="1.7" />
    </svg>
  );
}
