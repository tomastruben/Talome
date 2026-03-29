"use client";

import { useEffect, useRef, forwardRef, useImperativeHandle } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { ImageAddon } from "@xterm/addon-image";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import { CORE_URL, getTerminalDaemonHttpUrl, getTerminalDaemonWsUrl } from "@/lib/constants";

// ── iOS emoji → ANSI replacement ─────────────────────────────────────────────
// iOS renders Unicode emoji as oversized colorful glyphs that break terminal
// layout. Replace them with ANSI-colored geometric equivalents (● and ■) that
// render consistently in monospace fonts across all platforms.

// Optional variation selector \uFE0F may follow emoji characters
const VS = "\uFE0F?";
const emojiToAnsi: [RegExp, string][] = [
  // Circles
  [new RegExp(`🟢${VS}`, "g"), "\x1b[32m●\x1b[0m"],  // green
  [new RegExp(`🔵${VS}`, "g"), "\x1b[34m●\x1b[0m"],  // blue
  [new RegExp(`🟠${VS}`, "g"), "\x1b[33m●\x1b[0m"],  // orange → yellow
  [new RegExp(`🟡${VS}`, "g"), "\x1b[93m●\x1b[0m"],  // yellow (bright)
  [new RegExp(`🔴${VS}`, "g"), "\x1b[31m●\x1b[0m"],  // red
  [new RegExp(`🟣${VS}`, "g"), "\x1b[35m●\x1b[0m"],  // purple → magenta
  [new RegExp(`🟤${VS}`, "g"), "\x1b[33m●\x1b[0m"],  // brown → yellow
  [new RegExp(`⚪${VS}`, "g"), "\x1b[37m●\x1b[0m"],  // white
  [new RegExp(`⚫${VS}`, "g"), "\x1b[90m●\x1b[0m"],  // black (bright black)
  // Squares
  [new RegExp(`🟥${VS}`, "g"), "\x1b[31m■\x1b[0m"],  // red
  [new RegExp(`🟧${VS}`, "g"), "\x1b[33m■\x1b[0m"],  // orange → yellow
  [new RegExp(`🟨${VS}`, "g"), "\x1b[93m■\x1b[0m"],  // yellow (bright)
  [new RegExp(`🟩${VS}`, "g"), "\x1b[32m■\x1b[0m"],  // green
  [new RegExp(`🟦${VS}`, "g"), "\x1b[34m■\x1b[0m"],  // blue
  [new RegExp(`🟪${VS}`, "g"), "\x1b[35m■\x1b[0m"],  // purple → magenta
  [new RegExp(`🟫${VS}`, "g"), "\x1b[33m■\x1b[0m"],  // brown → yellow
  [new RegExp(`⬛${VS}`, "g"), "\x1b[90m■\x1b[0m"],  // black
  [new RegExp(`⬜${VS}`, "g"), "\x1b[37m■\x1b[0m"],  // white
];

function sanitizeEmoji(data: string): string {
  let result = data;
  for (const [pattern, replacement] of emojiToAnsi) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

export interface TerminalInnerHandle {
  sendCommand: (cmd: string) => void;
  /** Inject the taskPrompt into the PTY. Can be called multiple times (for retry). */
  injectPrompt: () => void;
  uploadImage: (file: File) => void;
  /** Reset reconnect counter and attempt a fresh connection. */
  retryConnect: () => void;
}

export type TerminalConnectionStatus = "connected" | "reconnecting" | "disconnected";

interface TerminalInnerProps {
  token: string;
  initialCommand?: string | null;
  onCommandSent?: () => void;
  /** Called with raw terminal output chunks after the initial command has been sent. */
  onOutput?: (data: string) => void;
  /**
   * If provided, auto-injects this prompt into the terminal after the initial
   * command finishes starting (detected via idle-gap in PTY output). Also
   * available as `handle.injectPrompt()` for manual triggering.
   */
  taskPrompt?: string | null;
  /** Called when the task prompt has been injected (auto or manual). */
  onPromptInjected?: () => void;
  /**
   * Optional persistent session ID. If provided, the terminal attaches to (or
   * creates) a named PTY session on the server that survives WebSocket reconnects
   * and panel navigation. The session ID is also persisted to localStorage so
   * reopening the panel reconnects to the same shell.
   *
   * If omitted, an ephemeral session is used (killed on disconnect).
   */
  sessionId?: string;
  sessionName?: string;
  /** Controls the inputMode on xterm's hidden textarea. "none" suppresses
   *  the virtual keyboard on iOS, "text" shows it. */
  inputMode?: "none" | "text";
  /** Called when WebSocket connection status changes. */
  onConnectionStatus?: (status: TerminalConnectionStatus) => void;
  /** Called when Claude Code remote control session is detected in terminal output. */
  onRemoteSession?: (active: boolean) => void;
}

const MAX_RECONNECT_ATTEMPTS = 15;

export const TerminalInner = forwardRef<TerminalInnerHandle, TerminalInnerProps>(
  function TerminalInner({ token, initialCommand, onCommandSent, onOutput, taskPrompt, onPromptInjected, sessionId, sessionName, inputMode = "text", onConnectionStatus, onRemoteSession }, ref) {
    const containerRef = useRef<HTMLDivElement>(null);
    const wsRef = useRef<WebSocket | null>(null);
    const termRef = useRef<Terminal | null>(null);
    const uploadImageRef = useRef<(blob: Blob) => void>(() => {});
    // Shared inject function — set inside the WS effect, called from imperative handle
    const injectFnRef = useRef<() => void>(() => {});
    const retryConnectRef = useRef<() => void>(() => {});

    useImperativeHandle(ref, () => ({
      sendCommand(cmd: string) {
        const ws = wsRef.current;
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "input", data: cmd + "\n" }));
        }
      },
      injectPrompt() {
        injectFnRef.current();
      },
      uploadImage(file: File) {
        uploadImageRef.current(file);
      },
      retryConnect() {
        retryConnectRef.current();
      },
    }));

    const initialCommandRef = useRef(initialCommand);
    const onCommandSentRef = useRef(onCommandSent);
    const onOutputRef = useRef(onOutput);
    const taskPromptRef = useRef(taskPrompt);
    const onPromptInjectedRef = useRef(onPromptInjected);
    const onConnectionStatusRef = useRef(onConnectionStatus);
    const onRemoteSessionRef = useRef(onRemoteSession);
    const sessionNameRef = useRef(sessionName);
    const commandSentRef = useRef(false);
    const remoteDetectedRef = useRef(false);

    useEffect(() => {
      initialCommandRef.current = initialCommand;
      onCommandSentRef.current = onCommandSent;
      onOutputRef.current = onOutput;
      taskPromptRef.current = taskPrompt;
      onPromptInjectedRef.current = onPromptInjected;
      onConnectionStatusRef.current = onConnectionStatus;
      onRemoteSessionRef.current = onRemoteSession;
      sessionNameRef.current = sessionName;
    }, [initialCommand, onCommandSent, onOutput, taskPrompt, onPromptInjected, onConnectionStatus, onRemoteSession, sessionName]);

    // Keep inputMode in sync — the main effect only runs on [token, sessionId],
    // so toggling the keyboard mode wouldn't update the textarea
    // attribute without this separate effect.
    useEffect(() => {
      const textarea = termRef.current?.textarea;
      if (textarea) {
        textarea.setAttribute("inputmode", inputMode);
      }
    }, [inputMode]);

    useEffect(() => {
      if (!containerRef.current) return;

      const term = new Terminal({
        fontFamily: '"Cascadia Code", "Fira Code", "Menlo", monospace',
        fontSize: 13,
        lineHeight: 1.4,
        cursorBlink: true,
        scrollback: 5000,
        theme: {
          background: "#0d1117",
          foreground: "#e6edf3",
          cursor: "#e6edf3",
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
      const imageAddon = new ImageAddon();
      const webLinksAddon = new WebLinksAddon();
      term.loadAddon(fitAddon);
      term.loadAddon(imageAddon);
      term.loadAddon(webLinksAddon);
      term.open(containerRef.current);

      // Session ID is always provided by the parent — no localStorage fallback.
      const resolvedSessionId = sessionId || undefined;

      let ws: WebSocket;
      let reconnectAttempts = 0;
      let destroyed = false;
      let daemonBootId: string | null = null;
      let resizeSent = false;
      let fitTimer: ReturnType<typeof setTimeout>;
      let authFailed = false;

      // ── Write buffer — coalesce rapid WebSocket messages ──────────────
      // Safari's WebKit engine struggles with hundreds of individual
      // write→parse→render cycles per second during rapid PTY output
      // (build logs, large directory listings). Buffering writes and
      // flushing once per animation frame reduces the per-frame work
      // to a single term.write() call, matching the display refresh rate.
      //
      // Cap at 64KB to prevent unbounded memory growth during extreme
      // output bursts (e.g. cat-ing a large file). When the cap is hit,
      // flush synchronously instead of waiting for the next rAF.
      const WRITE_BUFFER_CAP = 64 * 1024;
      let pendingWrite = "";
      let flushRaf = 0;
      let flushTimeout = 0;

      function flushWrites() {
        flushRaf = 0;
        if (flushTimeout) { clearTimeout(flushTimeout); flushTimeout = 0; }
        if (pendingWrite) {
          term.write(pendingWrite);
          pendingWrite = "";
        }
      }

      function bufferWrite(data: string | Uint8Array) {
        if (typeof data === "string") {
          pendingWrite += data;
        } else {
          // Binary: flush pending text first, then write binary directly
          if (pendingWrite) {
            term.write(pendingWrite);
            pendingWrite = "";
          }
          term.write(data);
          return;
        }
        // Flush immediately if buffer exceeds cap
        if (pendingWrite.length >= WRITE_BUFFER_CAP) {
          cancelAnimationFrame(flushRaf);
          flushRaf = 0;
          flushWrites();
          return;
        }
        if (!flushRaf && !destroyed) {
          flushRaf = requestAnimationFrame(flushWrites);
          // Safari throttles rAF during CSS animations and background tabs.
          // setTimeout fallback ensures writes always reach the terminal.
          if (!flushTimeout) {
            flushTimeout = window.setTimeout(flushWrites, 32) as unknown as number;
          }
        }
      }

      // ── Task prompt injection (all local to this effect) ─────────────
      let promptAutoInjected = false;
      let idleTimer: ReturnType<typeof setTimeout> | undefined;
      let fallbackTimer: ReturnType<typeof setTimeout> | undefined;

      function injectTaskPrompt() {
        const prompt = taskPromptRef.current;
        if (!prompt) return;

        clearTimeout(idleTimer);
        clearTimeout(fallbackTimer);

        // Write directly via WS (same connection, no HTTP hop)
        const currentWs = wsRef.current;
        if (currentWs && currentWs.readyState === WebSocket.OPEN) {
          currentWs.send(JSON.stringify({ type: "input", data: prompt + "\n" }));
        } else {
          // WS not open — try HTTP as last resort
          void fetch(`${getTerminalDaemonHttpUrl()}/sessions/${resolvedSessionId ?? ""}/input`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ data: prompt + "\n" }),
          }).catch(() => { /* silent */ });
        }

        onPromptInjectedRef.current?.();
      }

      function autoInjectTaskPrompt() {
        if (promptAutoInjected) return;
        promptAutoInjected = true;
        injectTaskPrompt();
      }

      // Expose inject to the imperative handle (can be called multiple times for retry)
      injectFnRef.current = injectTaskPrompt;

      async function getFreshAuthToken(): Promise<{ token: string; bootId?: string }> {
        // Primary path: get a token from the core API
        try {
          const res = await fetch(`${CORE_URL}/api/terminal/session`, { method: "POST" });
          if (res.ok) {
            const data = (await res.json()) as { token?: string; bootId?: string };
            if (data.token) return { token: data.token, bootId: data.bootId };
          }
        } catch {
          // Core is unreachable — try the daemon directly
        }

        // Fallback path: hit the daemon's /session endpoint directly.
        // This allows reconnection even when the core server is down
        // but the terminal daemon is still alive.
        try {
          const directRes = await fetch(`${getTerminalDaemonHttpUrl()}/session`, { method: "POST" });
          if (directRes.ok) {
            const data = (await directRes.json()) as { token?: string; bootId?: string };
            if (data.token) return { token: data.token, bootId: data.bootId };
          }
        } catch {
          // Daemon also unreachable — fall back to the original token
        }

        return { token };
      }

      function connect() {
        if (destroyed) return;

        // Close previous WebSocket if still open (e.g. manual retry)
        const prev = wsRef.current;
        if (prev && prev.readyState !== WebSocket.CLOSED) {
          try { prev.close(1000); } catch { /* ignore */ }
        }

        // Fetch a fresh auth token in parallel with the WebSocket handshake.
        // Ephemeral tokens are single-use, so we always need a new one —
        // but by starting the fetch here (before ws.onopen), the HTTP round-trip
        // overlaps with the TCP connect, adding no perceived latency.
        const freshTokenPromise = getFreshAuthToken();

        const wsUrl = `${getTerminalDaemonWsUrl()}/ws`;
        ws = new WebSocket(wsUrl);
        wsRef.current = ws;
        resizeSent = false;
        authFailed = false;
        // NOTE: Do NOT reset promptAutoInjected here — on a reconnect with a
        // preserved session, Claude Code is still running and re-injecting the
        // task prompt would send it as user input, disrupting the active session.
        // promptAutoInjected starts as false when the effect mounts and stays
        // true once the prompt has been delivered.
        clearTimeout(idleTimer);
        clearTimeout(fallbackTimer);

        ws.onopen = () => {
          const isReconnect = daemonBootId !== null;
          reconnectAttempts = 0;
          void (async () => {
            const { token: authToken, bootId } = await freshTokenPromise;
            const daemonRestarted = isReconnect && bootId != null && bootId !== daemonBootId;
            if (bootId) daemonBootId = bootId;
            if (destroyed || ws.readyState !== WebSocket.OPEN) return;

            const authMsg: Record<string, unknown> = { type: "auth", token: authToken };
            if (resolvedSessionId) {
              authMsg.sessionId = resolvedSessionId;
              authMsg.sessionName = sessionNameRef.current ?? resolvedSessionId;
            }
            ws.send(JSON.stringify(authMsg));

            onConnectionStatusRef.current?.("connected");
            if (isReconnect) {
              if (daemonRestarted) {
                // The daemon's buffer replay will include a "session restored"
                // marker if the session was recovered from persistence. Keep
                // the frontend message generic — the buffer content tells the
                // full story.
                term.write("\r\n\x1b[33m[reconnected after restart]\x1b[0m\r\n");
              } else {
                term.write("\r\n\x1b[32m[reconnected — session preserved]\x1b[0m\r\n");
              }
            }

            // Fit after auth
            requestAnimationFrame(() => {
              fitAddon.fit();
              fitTimer = setTimeout(() => {
                fitAddon.fit();
                if (ws.readyState === WebSocket.OPEN) {
                  ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
                }
              }, 100);
            });
          })();
        };

        ws.onmessage = (e) => {
          const rawData = typeof e.data === "string" ? e.data : "";

          // Detect auth failure messages from daemon before we've authenticated
          // (resizeSent is false until after successful auth + first data)
          if (!resizeSent && (rawData.includes("Authentication required") || rawData.includes("Invalid token"))) {
            authFailed = true;
          }

          bufferWrite(typeof e.data === "string" ? sanitizeEmoji(e.data) : new Uint8Array(e.data));
          if (!resizeSent) {
            resizeSent = true;
            fitAddon.fit();
            ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
            if (initialCommandRef.current && !commandSentRef.current) {
              setTimeout(() => {
                // Clear any pending input/escape sequences before sending the command
                ws.send(JSON.stringify({ type: "input", data: "\x15" })); // Ctrl+U: kill line
                setTimeout(() => {
                  ws.send(JSON.stringify({ type: "input", data: initialCommandRef.current + "\n" }));
                  commandSentRef.current = true;
                  onCommandSentRef.current?.();

                  // Start auto-injection timers if we have a task prompt.
                  // Use a generous fallback (12s) to account for Claude Code
                  // startup time — particularly after auth/reconnect delays.
                  if (taskPromptRef.current) {
                    fallbackTimer = setTimeout(autoInjectTaskPrompt, 12_000);
                  }
                }, 100);
              }, 300);
            }
          }

          // Detect Claude Code remote control session from PTY output.
          // Fires on ALL data (not just post-command) so it catches tmux reattach too.
          if (rawData && onRemoteSessionRef.current) {
            // Strip ANSI escape sequences for reliable pattern matching
            const clean = rawData.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
            const hasRemote = clean.includes("Session URL");
            if (hasRemote && !remoteDetectedRef.current) {
              remoteDetectedRef.current = true;
              onRemoteSessionRef.current(true);
            }
          }

          // Forward output to parent after the command has been dispatched
          if (commandSentRef.current && rawData && onOutputRef.current) {
            onOutputRef.current(rawData);
          }

          // Idle-gap detection for auto-injection: reset timer on each output chunk.
          // 2s idle gap — long enough that Claude Code's startup output won't
          // trigger premature injection, but short enough to feel responsive.
          if (commandSentRef.current && taskPromptRef.current && !promptAutoInjected) {
            clearTimeout(idleTimer);
            idleTimer = setTimeout(autoInjectTaskPrompt, 2000);
          }
        };

        ws.onerror = () => {
          term.write("\r\n\x1b[31mConnection error.\x1b[0m\r\n");
        };

        ws.onclose = (evt) => {
          if (destroyed) return;

          // Don't auto-reconnect on intentional close (code 1000), auth failure
          // (code 1008), or when auth failure was detected from message content
          if (evt.code === 1000 || evt.code === 1008 || authFailed) {
            if (authFailed) {
              term.write("\r\n\x1b[33m[authentication failed — click Reconnect to try again]\x1b[0m\r\n");
            } else {
              term.write("\r\n\x1b[33m[disconnected]\x1b[0m\r\n");
            }
            onConnectionStatusRef.current?.("disconnected");
            return;
          }

          reconnectAttempts++;
          if (reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
            term.write(`\r\n\x1b[31m[connection lost — click Reconnect to try again]\x1b[0m\r\n`);
            onConnectionStatusRef.current?.("disconnected");
            return;
          }

          onConnectionStatusRef.current?.("reconnecting");
          const delay = Math.min(1000 * Math.pow(2, reconnectAttempts - 1), 30_000);
          term.write(`\r\n\x1b[33m[reconnecting in ${Math.round(delay / 1000)}s…]\x1b[0m\r\n`);
          setTimeout(connect, delay);
        };
      }

      connect();

      retryConnectRef.current = () => {
        reconnectAttempts = 0;
        connect();
      };

      term.onData((data) => {
        if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
          wsRef.current.send(JSON.stringify({ type: "input", data }));
        }
      });

      // ── Image paste / drop → upload to server, inject file path ───────────
      async function handleImageBlob(blob: Blob) {
        const w = wsRef.current;
        if (!w || w.readyState !== WebSocket.OPEN) return;

        try {
          const formData = new FormData();
          const ext = blob.type.split("/")[1] || "png";
          formData.append("file", blob, `paste.${ext}`);

          const res = await fetch(`${getTerminalDaemonHttpUrl()}/upload`, {
            method: "POST",
            body: formData,
          });

          if (!res.ok) {
            term.write(`\r\n\x1b[31m[image upload failed: ${res.status}]\x1b[0m`);
            return;
          }

          const { path } = (await res.json()) as { path: string };
          // Inject the file path into the terminal so Claude Code picks it up
          w.send(JSON.stringify({ type: "input", data: path }));
        } catch {
          term.write(`\r\n\x1b[31m[image upload error]\x1b[0m`);
        }
      }

      termRef.current = term;
      uploadImageRef.current = handleImageBlob;

      function onPaste(e: ClipboardEvent) {
        if (!e.clipboardData) return;
        for (const item of e.clipboardData.items) {
          if (item.type.startsWith("image/")) {
            e.preventDefault();
            e.stopPropagation();
            const blob = item.getAsFile();
            if (blob) void handleImageBlob(blob);
            return;
          }
        }
        // Non-image paste falls through to xterm's default handler
      }

      function onDrop(e: DragEvent) {
        e.preventDefault();
        e.stopPropagation();
        if (!e.dataTransfer) return;
        for (const file of e.dataTransfer.files) {
          if (file.type.startsWith("image/")) {
            void handleImageBlob(file);
            return; // handle first image only
          }
        }
      }

      function onDragOver(e: DragEvent) {
        e.preventDefault();
      }

      const el = containerRef.current;

      // Attach paste listener to xterm's internal textarea — this is where
      // clipboard events actually fire, especially on iOS/mobile browsers.
      const xtermTextarea = term.textarea;

      // iOS Safari requires focus() to be called synchronously within a user
      // gesture (touchend). Tapping the xterm canvas hits the overlay div,
      // not the hidden textarea, so iOS won't show the keyboard unless we
      // listen for touch events on the canvas and manually focus the textarea.
      function onCanvasTouchEnd() {
        if (xtermTextarea) {
          xtermTextarea.focus({ preventScroll: true });
        }
      }
      // Attach to the xterm screen element (the canvas container) — this is
      // what the user actually taps on.
      const xtermScreen = el.querySelector(".xterm-screen") as HTMLElement | null;
      xtermScreen?.addEventListener("touchend", onCanvasTouchEnd);

      if (xtermTextarea) {
        xtermTextarea.addEventListener("paste", onPaste);
        xtermTextarea.setAttribute("autocapitalize", "none");
        xtermTextarea.setAttribute("autocorrect", "off");
        xtermTextarea.setAttribute("spellcheck", "false");
        // inputMode="none" suppresses the virtual keyboard + iOS system caret.
        // Controlled by the keyboard mode toggle from the toolbar.
        xtermTextarea.setAttribute("inputmode", inputMode);
        // Ensure the textarea is not excluded from the tab order and is
        // reachable by assistive technologies on mobile.
        xtermTextarea.setAttribute("enterkeyhint", "send");
      }
      // Also listen on the container for drag-and-drop
      el.addEventListener("paste", onPaste);
      el.addEventListener("drop", onDrop);
      el.addEventListener("dragover", onDragOver);

      // Debounce ResizeObserver with rAF to prevent the "ResizeObserver loop
      // completed with undelivered notifications" error. fitAddon.fit() changes
      // the terminal's internal dimensions which can trigger re-entrant
      // notifications within the same frame.
      let resizeRaf = 0;
      const ro = new ResizeObserver(() => {
        cancelAnimationFrame(resizeRaf);
        resizeRaf = requestAnimationFrame(() => {
          if (destroyed) return;

          // Preserve scroll position when the user has scrolled up.
          // fitAddon.fit() → terminal.resize() can reset the viewport
          // to the bottom, which is jarring during streaming output
          // (e.g. Claude Code sessions) when the user is reading earlier
          // output. Classical terminals hold scroll position on resize.
          const buf = term.buffer.active;
          const wasScrolledUp = buf.viewportY < buf.baseY;
          const savedOffset = buf.baseY - buf.viewportY;

          fitAddon.fit();

          if (wasScrolledUp) {
            // Restore: scroll back up by the same offset from bottom
            const newBase = term.buffer.active.baseY;
            const targetLine = newBase - savedOffset;
            term.scrollToLine(Math.max(0, targetLine));
          }

          const w = wsRef.current;
          if (w && w.readyState === WebSocket.OPEN) {
            w.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
          }
        });
      });
      ro.observe(el);

      return () => {
        destroyed = true;
        clearTimeout(fitTimer);
        clearTimeout(idleTimer);
        clearTimeout(fallbackTimer);
        clearTimeout(flushTimeout);
        cancelAnimationFrame(flushRaf);
        cancelAnimationFrame(resizeRaf);
        wsRef.current = null;
        ws.close(1000);
        term.dispose();
        xtermScreen?.removeEventListener("touchend", onCanvasTouchEnd);
        if (xtermTextarea) {
          xtermTextarea.removeEventListener("paste", onPaste);
        }
        el.removeEventListener("paste", onPaste);
        el.removeEventListener("drop", onDrop);
        el.removeEventListener("dragover", onDragOver);
        ro.unobserve(el);
        ro.disconnect();
      };
    // sessionName is read from sessionNameRef — not a dependency. Only token
    // and sessionId changes warrant a full WebSocket reconnection. Display name
    // updates are cosmetic and must NOT tear down the connection.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [token, sessionId]);

    return (
      <div
        className="terminal-host flex-1 min-h-0 w-full pl-3 pt-1"
        style={{ background: "#0d1117" }}
        // Use onTouchEnd instead of onClick — iOS Safari requires the focus()
        // call to happen in the same call-stack as a direct user gesture on a
        // touch event. React's synthetic onClick fires after touchend, and the
        // async hop can cause iOS to suppress the virtual keyboard. We keep
        // onClick as a fallback for desktop/mouse users.
        onTouchEnd={(e) => {
          // Only trigger if the tap lands on the terminal area itself, not on
          // an interactive child (scrollbar, selection handle, link).
          if (e.target === e.currentTarget || containerRef.current?.contains(e.target as Node)) {
            termRef.current?.focus();
          }
        }}
        onClick={() => termRef.current?.focus()}
      >
        <div
          ref={containerRef}
          className="h-full w-full"
          style={{ background: "#0d1117" }}
        />
      </div>
    );
  },
);
