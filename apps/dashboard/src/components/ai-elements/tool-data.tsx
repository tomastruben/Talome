"use client";

import { Fragment, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { ComponentProps, ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/ui/copy-button";
import { cn } from "@/lib/utils";
import { useConversationScrollLock } from "./conversation";

/**
 * How tall a tool card's blocks grow before they scroll on their own, so an
 * expanded card never takes over a window (a raw result once measured 3,865px
 * in a 625px window). Parameters are usually a few lines; a raw result gets a
 * little more room; a structured result (rows with buttons) the most.
 */
export const TOOL_BLOCK_CAP = {
  parameters: "max-h-32",
  result: "max-h-48",
  card: "max-h-72",
} as const;

export type ToolBlockCap = (typeof TOOL_BLOCK_CAP)[keyof typeof TOOL_BLOCK_CAP];

/** Nothing worth a "Parameters" block: no input, or an empty object. */
export function isEmptyToolData(value: unknown): boolean {
  if (value === undefined || value === null || value === "") return true;
  if (typeof value === "object" && !Array.isArray(value)) return Object.keys(value).length === 0;
  return false;
}

/**
 * The text a block shows and copies. Objects (and strings that hold JSON)
 * are pretty-printed with two-space indents; anything else is shown as is.
 */
export function formatToolData(value: unknown): { text: string; json: boolean } {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        return { text: JSON.stringify(JSON.parse(trimmed), null, 2), json: true };
      } catch {
        // Not JSON after all: show the text
      }
    }
    return { text: value, json: false };
  }
  if (value === undefined) return { text: "", json: false };
  try {
    const text = JSON.stringify(value, null, 2);
    return text === undefined ? { text: String(value), json: false } : { text, json: true };
  } catch {
    return { text: String(value), json: false };
  }
}

/** `  "key": value` in pretty-printed JSON; the key is the first quoted string. */
const JSON_KEY_LINE = /^(\s*)("(?:[^"\\]|\\.)*")(:\s?)(.*)$/;
/** Past this, tinting keys costs more than it helps: the text renders plain. */
const MAX_TINTED_LINES = 2000;

/** Pretty-printed JSON with its keys muted, so the values stand out. */
function JsonText({ text }: { text: string }) {
  const lines = text.split("\n");
  if (lines.length > MAX_TINTED_LINES) return <>{text}</>;
  return (
    <>
      {lines.map((line, index) => {
        const newline = index < lines.length - 1 ? "\n" : null;
        const match = JSON_KEY_LINE.exec(line);
        if (!match) {
          return (
            <Fragment key={index}>
              {line}
              {newline}
            </Fragment>
          );
        }
        const [, indent, key, colon, rest] = match;
        return (
          <Fragment key={index}>
            {indent}
            <span className="text-muted-foreground">{key}</span>
            {colon}
            {rest}
            {newline}
          </Fragment>
        );
      })}
    </>
  );
}

/**
 * A block capped at `cap` with its own scroller, and "Show all" / "Show less"
 * when its content is taller than that. The toggle appears only when the
 * content really overflows (measured, and re-measured as it streams in).
 *
 * "Show all" first releases the conversation's stick-to-bottom lock, so the
 * view stays where you were reading instead of jumping to the new bottom.
 * "Show less" scrolls the block back to its start and keeps the toggle in
 * view, so collapsing a long result never strands you below it.
 */
export function ToolCappedRegion({
  label,
  cap,
  className,
  children,
}: {
  /** Names the block for assistive tech: "Parameters", "Result". */
  label: string;
  cap: ToolBlockCap;
  /** The block's fill. */
  className?: string;
  children: ReactNode;
}) {
  const id = useId();
  const regionRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const revealToggle = useRef(false);
  const releaseScrollLock = useConversationScrollLock();
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);

  // Measured only while capped; once expanded the block was known to overflow.
  useEffect(() => {
    if (expanded) return;
    const region = regionRef.current;
    const content = contentRef.current;
    if (!region || !content) return;
    const measure = () => setOverflowing(region.scrollHeight > region.clientHeight + 1);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(region);
    observer.observe(content);
    return () => observer.disconnect();
  }, [expanded]);

  useLayoutEffect(() => {
    if (!revealToggle.current) return;
    revealToggle.current = false;
    regionRef.current?.scrollTo?.({ top: 0 });
    toggleRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [expanded]);

  const toggle = () => {
    if (expanded) {
      revealToggle.current = true;
      setExpanded(false);
      return;
    }
    releaseScrollLock?.();
    setExpanded(true);
  };

  const scrolls = overflowing && !expanded;

  return (
    <div className="flex min-w-0 flex-col items-start gap-1">
      <div
        id={id}
        ref={regionRef}
        role="group"
        aria-label={label}
        // A block that scrolls is reachable from the keyboard
        tabIndex={scrolls ? 0 : undefined}
        data-tool-block=""
        data-expanded={expanded ? "" : undefined}
        className={cn(
          "w-full min-w-0 overflow-y-auto rounded-lg",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
          !expanded && cap,
          className,
        )}
      >
        <div ref={contentRef}>{children}</div>
      </div>
      {overflowing || expanded ? (
        <Button
          ref={toggleRef}
          type="button"
          variant="ghost"
          size="xs"
          aria-expanded={expanded}
          aria-controls={id}
          onClick={toggle}
          className="text-muted-foreground hover:text-foreground phone-touch:min-h-11"
        >
          {expanded ? "Show less" : "Show all"}
        </Button>
      ) : null}
    </div>
  );
}

export type ToolDataBlockProps = Omit<ComponentProps<"div">, "children"> & {
  /** Sentence case: "Parameters", "Result", "Error". */
  label: string;
  value: unknown;
  cap: ToolBlockCap;
  /** "error" lays the critical tint under the text (body text stays foreground). */
  tone?: "default" | "error";
};

/**
 * A tool call's parameters or raw result: a label, a Copy button, and the
 * value as compact monospace text that wraps (long strings break anywhere
 * instead of scrolling sideways), capped with its own scroller. It paints a
 * relative fill, never an opaque one, so it reads on window glass.
 */
export function ToolDataBlock({ label, value, cap, tone = "default", className, ...props }: ToolDataBlockProps) {
  const textRef = useRef<HTMLPreElement>(null);
  const { text, json } = formatToolData(value);

  return (
    <div className={cn("min-w-0 space-y-1.5", className)} {...props}>
      <div className="flex min-h-6 items-center justify-between gap-2">
        <h4 className="text-xs font-medium text-muted-foreground">{label}</h4>
        <CopyButton
          value={text}
          label={`Copy ${label.toLowerCase()}`}
          size="icon-xs"
          selectOnFailRef={textRef}
          className="text-muted-foreground hover:text-foreground phone-touch:size-11"
        />
      </div>
      <ToolCappedRegion
        label={label}
        cap={cap}
        className={tone === "error" ? "bg-status-critical/12" : "bg-muted/40"}
      >
        <pre
          ref={textRef}
          className="m-0 whitespace-pre-wrap px-3 py-2 font-mono text-xs leading-relaxed text-foreground wrap-anywhere"
        >
          {json ? <JsonText text={text} /> : text}
        </pre>
      </ToolCappedRegion>
    </div>
  );
}
