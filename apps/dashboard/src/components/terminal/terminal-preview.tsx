"use client";

import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { CORE_URL, getTerminalDaemonWsUrl } from "@/lib/constants";

interface TerminalPreviewProps {
  /** Session ID to connect to (e.g. "sess_evolution-ev_123"). */
  sessionId: string;
  /** Container height class. Default: "h-28" (~5-6 lines). */
  heightClass?: string;
}

/**
 * Compact, read-only xterm.js terminal preview.
 *
 * Connects to an existing PTY session via WebSocket, receives the full
 * scroll buffer replay, and renders the last N lines. No input is accepted.
 * Each instance fetches its own fresh ephemeral token (they are one-time use).
 */
export function TerminalPreview({
  sessionId,
  heightClass = "h-28",
}: TerminalPreviewProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    let cancelled = false;

    const term = new Terminal({
      fontFamily: '"Cascadia Code", "Fira Code", "Menlo", monospace',
      fontSize: 12,
      lineHeight: 1.35,
      cursorBlink: false,
      cursorStyle: "bar",
      cursorInactiveStyle: "none",
      scrollback: 500,
      disableStdin: true,
      theme: {
        background: "#0d1117",
        foreground: "#e6edf3",
        cursor: "transparent",
        selectionBackground: "#264f78",
        black: "#0d1117",
        brightBlack: "#8b949e",
        red: "#ff7b72",
        brightRed: "#ffa198",
        green: "#3fb950",
        brightGreen: "#56d364",
        yellow: "#d29922",
        brightYellow: "#e3b341",
        blue: "#58a6ff",
        brightBlue: "#79c0ff",
        magenta: "#bc8cff",
        brightMagenta: "#d2a8ff",
        cyan: "#76e3ea",
        brightCyan: "#b3f0ff",
        white: "#b1bac4",
        brightWhite: "#f0f6fc",
      },
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(containerRef.current);

    // Hide the textarea to prevent focus/input entirely
    const textarea = term.textarea;
    if (textarea) {
      textarea.setAttribute("tabindex", "-1");
      textarea.style.pointerEvents = "none";
    }

    // Fit to container
    try {
      fitAddon.fit();
    } catch {
      // Container may not be visible yet
    }

    let ws: WebSocket | null = null;

    // Fetch a fresh ephemeral token, then connect WebSocket
    async function connect() {
      try {
        const res = await fetch(`${CORE_URL}/api/terminal/session`, { method: "POST" });
        if (!res.ok || cancelled) return;
        const data = (await res.json()) as { token?: string };
        if (!data.token || cancelled) return;

        ws = new WebSocket(`${getTerminalDaemonWsUrl()}/ws`);

        ws.onopen = () => {
          ws!.send(JSON.stringify({
            type: "auth",
            token: data.token,
            sessionId,
            sessionName: sessionId,
          }));
        };

        ws.onmessage = (e) => {
          if (typeof e.data === "string") {
            term.write(e.data);
            term.scrollToBottom();
          }
        };
      } catch {
        // Token fetch failed — preview stays empty, no crash
      }
    }

    void connect();

    // Resize observer for container changes
    const ro = new ResizeObserver(() => {
      try {
        fitAddon.fit();
      } catch {
        // ignore
      }
    });
    ro.observe(containerRef.current);

    return () => {
      cancelled = true;
      ro.disconnect();
      ws?.close();
      term.dispose();
    };
  }, [sessionId]);

  return (
    <div
      ref={containerRef}
      className={`${heightClass} rounded-lg overflow-hidden border border-border/30`}
      style={{ background: "#0d1117" }}
    />
  );
}
