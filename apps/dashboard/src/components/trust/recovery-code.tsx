"use client";

import { useId, useRef, useState } from "react";
import { HugeiconsIcon, Download01Icon, PrinterIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/ui/copy-button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  lastRecoveryGroup,
  matchesLastGroup,
  recoveryCodeDocument,
  recoveryCodeGroups,
} from "@/lib/recovery-code";
import { cn } from "@/lib/utils";

/** Save the code as a small text file. */
function downloadCode(code: string, username?: string) {
  const blob = new Blob([recoveryCodeDocument(code, username)], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = username ? `talome-recovery-code-${username}.txt` : "talome-recovery-code.txt";
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/**
 * Print only the code: a hidden iframe holds a one-page document, so the
 * rest of the screen never reaches the printer and no pop-up is needed.
 */
function printCode(code: string, username?: string) {
  const frame = document.createElement("iframe");
  frame.setAttribute("aria-hidden", "true");
  frame.tabIndex = -1;
  frame.style.position = "fixed";
  frame.style.width = "0";
  frame.style.height = "0";
  frame.style.border = "0";
  document.body.appendChild(frame);
  const doc = frame.contentDocument;
  const win = frame.contentWindow;
  if (!doc || !win) {
    frame.remove();
    return;
  }
  const pre = doc.createElement("pre");
  pre.textContent = recoveryCodeDocument(code, username);
  pre.style.font = "14px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace";
  pre.style.whiteSpace = "pre-wrap";
  doc.title = "Talome recovery code";
  doc.body.appendChild(pre);
  win.focus();
  win.print();
  setTimeout(() => frame.remove(), 1000);
}

export interface RecoveryCodeRevealProps {
  code: string;
  /** Whose code this is. Shown in the file name and in Download/Print. */
  username?: string;
  /** "Continue" on the sign-in and setup screens, "Done" in the admin dialog. */
  continueLabel?: string;
  onContinue: () => void;
  /** Hint above the confirm field. Defaults to the first-person wording. */
  confirmHint?: string;
  className?: string;
}

/**
 * Shows a recovery code once: six groups of four, Copy, Download and Print,
 * and a "type the last group" check before Continue, so nobody leaves this
 * screen without having saved the code somewhere.
 */
export function RecoveryCodeReveal({
  code,
  username,
  continueLabel = "Continue",
  onContinue,
  confirmHint = "Type the last group of the code to confirm you saved it.",
  className,
}: RecoveryCodeRevealProps) {
  const ids = useId();
  const codeRef = useRef<HTMLDivElement>(null);
  const [typed, setTyped] = useState("");
  const [attempted, setAttempted] = useState(false);
  const groups = recoveryCodeGroups(code);
  const confirmed = matchesLastGroup(code, typed);
  const showMismatch = attempted && !confirmed;
  const confirmId = `${ids}-confirm`;
  const hintId = `${ids}-hint`;
  const errorId = `${ids}-error`;

  return (
    <div className={cn("flex flex-col gap-4", className)}>
      <div className="rounded-lg border border-border bg-muted/40 p-4">
        <div
          ref={codeRef}
          role="group"
          aria-label={`Recovery code: ${groups.join(", ")}`}
          className="grid grid-cols-3 gap-x-3 gap-y-2 font-mono text-base tabular-nums text-foreground select-all"
        >
          {groups.map((group, index) => (
            <span key={`${group}-${index}`} className="text-center tracking-widest">
              {group}
            </span>
          ))}
        </div>
        <div className="mt-4 flex flex-wrap items-start justify-center gap-2">
          <CopyButton
            value={code}
            label="Copy recovery code"
            size="sm"
            variant="outline"
            selectOnFailRef={codeRef}
          />
          <Button type="button" variant="outline" size="sm" onClick={() => downloadCode(code, username)}>
            <HugeiconsIcon icon={Download01Icon} size={14} strokeWidth={1.5} aria-hidden="true" />
            Download
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={() => printCode(code, username)}>
            <HugeiconsIcon icon={PrinterIcon} size={14} strokeWidth={1.5} aria-hidden="true" />
            Print
          </Button>
        </div>
      </div>

      <p className="text-sm text-muted-foreground">
        Talome shows this code only once. It works one time: after you use it, you get a new one.
      </p>

      <form
        className="flex flex-col gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          setAttempted(true);
          if (confirmed) onContinue();
        }}
      >
        <label htmlFor={confirmId} className="text-sm font-medium text-foreground">
          Last group of the code
        </label>
        <p id={hintId} className="text-xs text-muted-foreground">
          {confirmHint}
        </p>
        <Input
          id={confirmId}
          value={typed}
          onChange={(event) => setTyped(event.target.value)}
          onBlur={() => typed && setAttempted(true)}
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          maxLength={12}
          placeholder={lastRecoveryGroup(code).replace(/./g, "•")}
          aria-invalid={showMismatch || undefined}
          aria-describedby={showMismatch ? `${hintId} ${errorId}` : hintId}
          className="h-10 font-mono tracking-widest"
        />
        {showMismatch ? (
          <p id={errorId} role="alert" className="text-xs text-status-critical">
            That doesn&apos;t match the last group. Check the code above and try again.
          </p>
        ) : null}
        <Button type="submit" className="mt-2 h-10 w-full" aria-disabled={!confirmed || undefined}>
          {continueLabel}
        </Button>
      </form>
    </div>
  );
}

/**
 * An admin-issued code (new member, or a regenerated code) in a dialog. The
 * dialog can't be dismissed until the code is confirmed: the old code
 * already stopped working, so losing this one to Esc would lock the person
 * out of self-service recovery.
 */
export function RecoveryCodeDialog({
  code,
  username,
  onDone,
}: {
  code: string | null;
  username?: string;
  onDone: () => void;
}) {
  return (
    <Dialog open={code !== null}>
      <DialogContent
        className="gap-4 sm:max-w-md"
        showCloseButton={false}
        onEscapeKeyDown={(event) => event.preventDefault()}
        onPointerDownOutside={(event) => event.preventDefault()}
        onInteractOutside={(event) => event.preventDefault()}
      >
        <DialogHeader className="text-left">
          <DialogTitle className="text-base font-medium">
            {username ? `Recovery code for ${username}` : "Recovery code"}
          </DialogTitle>
          <DialogDescription>
            Give this code to {username ?? "them"} privately. It lets them set a new password if they forget theirs.
          </DialogDescription>
        </DialogHeader>
        {code ? (
          <RecoveryCodeReveal
            code={code}
            username={username}
            continueLabel="Done"
            confirmHint="Type the last group to confirm you saved or passed it on."
            onContinue={onDone}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
