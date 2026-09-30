"use client";

import { forwardRef, useId, useState, type ComponentProps, type ReactNode } from "react";
import { motion } from "motion/react";
import { HugeiconsIcon, ViewIcon, ViewOffSlashIcon, AlertCircleIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { tween } from "@/lib/motion";
import { cn } from "@/lib/utils";

/** Talome's mark at full contrast (sign-in and setup). */
function TalomeMark() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className="text-foreground">
      <circle cx="12" cy="4.5" r="1.7" /><circle cx="17.1" cy="7" r="1.27" opacity="0.56" /><circle cx="12" cy="9.5" r="0.72" opacity="0.12" /><circle cx="6.5" cy="12" r="1.27" opacity="0.56" /><circle cx="12" cy="14.5" r="1.7" /><circle cx="17.5" cy="17" r="1.27" opacity="0.56" /><circle cx="12" cy="19.5" r="0.72" opacity="0.12" /><circle cx="12" cy="4.5" r="0.72" opacity="0.12" /><circle cx="6.5" cy="7" r="1.27" opacity="0.56" /><circle cx="12" cy="9.5" r="1.7" /><circle cx="17.5" cy="12" r="1.27" opacity="0.56" /><circle cx="12" cy="14.5" r="0.72" opacity="0.12" /><circle cx="6.5" cy="17" r="1.27" opacity="0.56" /><circle cx="12" cy="19.5" r="1.7" />
    </svg>
  );
}

/**
 * The frame shared by /login and /setup: brand mark, one h1, a subtitle and
 * the form. The column fades in over 150ms (opacity only).
 */
export function AuthShell({
  title,
  subtitle,
  children,
  footer = "Your data stays on your server.",
}: {
  title: string;
  subtitle?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-background p-6">
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={tween()}
        className="w-full max-w-sm"
      >
        <div className="mb-8 flex flex-col items-center text-center">
          <div className="mb-4 flex size-10 items-center justify-center rounded-full bg-muted">
            <TalomeMark />
          </div>
          <h1 className="text-2xl font-medium tracking-tight text-foreground">{title}</h1>
          {subtitle ? <p className="mt-2 text-sm text-muted-foreground">{subtitle}</p> : null}
        </div>
        {children}
        {footer ? <p className="mt-8 text-center text-xs text-muted-foreground">{footer}</p> : null}
      </motion.div>
    </main>
  );
}

/** A labelled field: label above the input, optional hint, error linked with aria-describedby. */
export const AuthField = forwardRef<
  HTMLInputElement,
  Omit<ComponentProps<typeof Input>, "id"> & {
    label: string;
    hint?: string;
    error?: string | null;
    /** Adds a show/hide toggle (aria-pressed) for passwords. */
    revealable?: boolean;
  }
>(function AuthField({ label, hint, error, revealable = false, type, className, ...props }, ref) {
  const id = useId();
  const [revealed, setRevealed] = useState(false);
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(" ") || undefined;
  const inputType = revealable ? (revealed ? "text" : "password") : type;

  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={id} className="text-sm font-medium text-foreground">
        {label}
      </label>
      <div className="relative">
        <Input
          ref={ref}
          id={id}
          type={inputType}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          className={cn("h-10", revealable && "pr-11", className)}
          {...props}
        />
        {revealable ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Show password"
            aria-pressed={revealed}
            title={revealed ? "Hide password" : "Show password"}
            onClick={() => setRevealed((value) => !value)}
            className="absolute top-1 right-1 pointer-coarse:size-11 pointer-coarse:top-0 pointer-coarse:right-0"
          >
            <HugeiconsIcon icon={revealed ? ViewOffSlashIcon : ViewIcon} size={16} strokeWidth={1.5} aria-hidden="true" />
          </Button>
        ) : null}
      </div>
      {hint ? (
        <p id={hintId} className="text-xs text-muted-foreground">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} className="text-xs text-status-critical">
          {error}
        </p>
      ) : null}
    </div>
  );
});

/** A form-level error: role=alert, names the fix. */
export function AuthError({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p role="alert" className="flex items-start gap-2 text-sm text-status-critical">
      <HugeiconsIcon icon={AlertCircleIcon} size={14} strokeWidth={1.5} aria-hidden="true" className="mt-0.5 shrink-0" />
      <span>{message}</span>
    </p>
  );
}

/** A text-link button with the designed focus ring. */
export function AuthLink({ className, ...props }: ComponentProps<"button">) {
  return (
    <button
      type="button"
      className={cn(
        "rounded-sm text-sm text-muted-foreground transition-colors duration-150 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background outline-none pointer-coarse:min-h-11",
        className,
      )}
      {...props}
    />
  );
}
