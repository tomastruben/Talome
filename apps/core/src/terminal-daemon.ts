/**
 * Terminal Daemon — runs on a fixed port (default :4001), separate from the
 * main Talome server. Owns all PTY sessions and WebSocket connections for their
 * full lifetime. Because it is NOT run under `tsx watch`, it survives any
 * server restarts triggered by file edits — keeping shell sessions alive.
 *
 * Session persistence: session metadata and scroll buffers are persisted to
 * SQLite so sessions can be recovered after daemon restarts (e.g. container
 * rebuilds). On startup, recoverable sessions are loaded from the DB and
 * lazily restored when a client reconnects — spawning a fresh PTY but
 * replaying the old scroll buffer so context is preserved.
 *
 * Started via: pnpm --filter @talome/core terminal-daemon
 * Or inline with the main dev script in package.json.
 */

import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import { Hono } from "hono";
import { cors } from "hono/cors";
import type { WSContext } from "hono/ws";
import * as pty from "node-pty";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { join } from "node:path";
import { mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { DAEMON_PORT } from "./terminal-constants.js";

// ── Config ────────────────────────────────────────────────────────────────────

export { DAEMON_PORT };

/** Unique ID generated each time the daemon starts — lets clients detect restarts. */
const BOOT_ID = randomUUID();

const PID_FILE = join(homedir(), ".talome", "terminal-daemon.pid");

function writePidFile() {
  mkdirSync(join(homedir(), ".talome"), { recursive: true });
  writeFileSync(PID_FILE, String(process.pid), "utf-8");
}

function cleanupPidFile() {
  try { unlinkSync(PID_FILE); } catch { /* ignore */ }
}

const PROJECT_ROOT = resolve(fileURLToPath(import.meta.url), "../../../..");

// ── Minimal DB access for MCP token verification ──────────────────────────────
// We open the same SQLite file as the main server for Bearer token auth.

const dbPath = process.env.DATABASE_PATH || join(process.cwd(), "data", "talome.db");
mkdirSync(join(dbPath, ".."), { recursive: true });
const sqlite = new Database(dbPath);
sqlite.pragma("journal_mode = WAL");

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function verifyBearerToken(authHeader: string | null | undefined): boolean {
  if (!authHeader?.startsWith("Bearer ")) return false;
  const raw = authHeader.slice(7).trim();
  if (!raw) return false;
  const hash = hashToken(raw);
  const row = sqlite.prepare("SELECT id FROM mcp_tokens WHERE token_hash = ?").get(hash) as { id: string } | undefined;
  return !!row;
}

// ── Ephemeral auth tokens (in-memory, 60s TTL) ────────────────────────────────

const ephemeralTokens = new Map<string, number>(); // token → expiresAt (ms)

function createEphemeralToken(): string {
  const now = Date.now();
  for (const [token, expiresAt] of ephemeralTokens) {
    if (expiresAt < now) ephemeralTokens.delete(token);
  }
  const token = `eph_${randomUUID().replace(/-/g, "")}`;
  ephemeralTokens.set(token, now + 60_000);
  return token;
}

function verifyEphemeralToken(token: string): boolean {
  const expiresAt = ephemeralTokens.get(token);
  if (!expiresAt || expiresAt < Date.now()) return false;
  ephemeralTokens.delete(token); // one-time use
  return true;
}

// ── PTY session registry ──────────────────────────────────────────────────────

const SCROLL_BUFFER_SIZE = 500;
const SESSION_IDLE_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours

interface PtySession {
  id: string;
  name: string;
  displayName?: string;
  proc: ReturnType<typeof pty.spawn>;
  buffer: string[];
  clients: Set<WSContext>;
  createdAt: number;
  lastActivityAt: number;
  cols: number;
  rows: number;
  /** Whether this session was recovered from a previous daemon boot. */
  recovered: boolean;
}

const sessions = new Map<string, PtySession>();

// ── Session persistence (SQLite) ──────────────────────────────────────────────
// Persists session metadata + scroll buffers so sessions survive daemon restarts.

sqlite.exec(`
  CREATE TABLE IF NOT EXISTS terminal_sessions (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    display_name TEXT,
    scroll_buffer TEXT NOT NULL DEFAULT '',
    cols INTEGER NOT NULL DEFAULT 80,
    rows INTEGER NOT NULL DEFAULT 24,
    created_at INTEGER NOT NULL,
    last_activity_at INTEGER NOT NULL
  )
`);

sqlite.exec(`
  CREATE TABLE IF NOT EXISTS daemon_auth (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )
`);

const backupAuthTokens = new Map<string, number>(); // token → expiresAt
const authAttempts = new Map<string, { count: number; blockedUntil: number }>(); // ip → attempts

function verifyBackupToken(token: string): boolean {
  const expiresAt = backupAuthTokens.get(token);
  return !!expiresAt && expiresAt > Date.now();
}

const upsertSessionStmt = sqlite.prepare(`
  INSERT OR REPLACE INTO terminal_sessions
    (id, name, display_name, scroll_buffer, cols, rows, created_at, last_activity_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);
const deletePersistedSessionStmt = sqlite.prepare(
  "DELETE FROM terminal_sessions WHERE id = ?",
);

interface RecoveredSessionMeta {
  name: string;
  displayName?: string;
  buffer: string;
  cols: number;
  rows: number;
  createdAt: number;
  lastActivityAt: number;
}

/** Sessions from the previous daemon boot, loaded on startup. */
const recoveredSessions = new Map<string, RecoveredSessionMeta>();

/** Load sessions persisted by the previous daemon boot into the recovery map. */
function loadRecoverableSessions() {
  const rows = sqlite
    .prepare(
      "SELECT id, name, display_name, scroll_buffer, cols, rows, created_at, last_activity_at FROM terminal_sessions",
    )
    .all() as {
    id: string;
    name: string;
    display_name: string | null;
    scroll_buffer: string;
    cols: number;
    rows: number;
    created_at: number;
    last_activity_at: number;
  }[];

  const now = Date.now();
  for (const row of rows) {
    // Ephemeral sessions and expired sessions don't survive restarts
    if (
      row.id.startsWith("eph_") ||
      now - row.last_activity_at > SESSION_IDLE_TTL_MS
    ) {
      deletePersistedSessionStmt.run(row.id);
      continue;
    }
    recoveredSessions.set(row.id, {
      name: row.name,
      displayName: row.display_name || undefined,
      buffer: row.scroll_buffer,
      cols: row.cols,
      rows: row.rows,
      createdAt: row.created_at,
      lastActivityAt: row.last_activity_at,
    });
  }

  if (recoveredSessions.size > 0) {
    console.log(
      `[terminal-daemon] Recovered ${recoveredSessions.size} session(s) from previous boot`,
    );
  }
}

/** Persist a single session's state to SQLite. */
function persistSession(session: PtySession) {
  if (session.id.startsWith("eph_")) return;
  upsertSessionStmt.run(
    session.id,
    session.name,
    session.displayName || null,
    session.buffer.join(""),
    session.cols,
    session.rows,
    session.createdAt,
    session.lastActivityAt,
  );
}

/** Persist all active sessions to SQLite (transactional). */
function persistAllSessions() {
  if (sessions.size === 0) return;
  const tx = sqlite.transaction(() => {
    for (const session of sessions.values()) {
      persistSession(session);
    }
  });
  tx();
}

// Load recoverable sessions on startup
loadRecoverableSessions();

/** Display names received before the PTY session exists (race between PATCH and WS connect). */
const pendingDisplayNames = new Map<string, string>();

function getOrCreateSession(id: string, name: string): PtySession {
  const existing = sessions.get(id);
  if (existing) {
    existing.lastActivityAt = Date.now();
    return existing;
  }

  // Check for a session recoverable from the previous daemon boot
  const recovered = recoveredSessions.get(id);

  const proc = pty.spawn(process.env.SHELL ?? "/bin/bash", [], {
    name: "xterm-256color",
    cols: recovered?.cols ?? 80,
    rows: recovered?.rows ?? 24,
    cwd: process.env.HOME ?? "/",
    env: { ...(process.env as Record<string, string>), TERM: "xterm-256color" },
  });

  const pendingName = pendingDisplayNames.get(id);
  if (pendingName) pendingDisplayNames.delete(id);

  const session: PtySession = {
    id,
    name: recovered?.name ?? name,
    displayName: pendingName ?? recovered?.displayName,
    proc,
    buffer: [],
    clients: new Set(),
    createdAt: recovered?.createdAt ?? Date.now(),
    lastActivityAt: Date.now(),
    cols: recovered?.cols ?? 80,
    rows: recovered?.rows ?? 24,
    recovered: !!recovered,
  };

  // Pre-fill buffer with recovered scroll history so clients see old output
  if (recovered && recovered.buffer) {
    const separator =
      "\r\n\x1b[90m── session restored ──\x1b[0m\r\n\r\n";
    session.buffer.push(recovered.buffer, separator);
    recoveredSessions.delete(id);
  } else if (recovered) {
    recoveredSessions.delete(id);
  }

  // Batch PTY output broadcasts: node-pty's onData can fire many times
  // per event-loop tick during rapid output. Coalescing chunks into a
  // single WebSocket send per microtask reduces frame count and per-message
  // compression overhead — particularly important for Safari which handles
  // high-frequency small WebSocket messages less efficiently than Chrome.
  let pendingBroadcast = "";
  let broadcastScheduled = false;
  const MAX_BROADCAST_PENDING = 131072; // 128KB — cap to prevent memory spikes

  proc.onData((data) => {
    session.buffer.push(data);
    if (session.buffer.length > SCROLL_BUFFER_SIZE) {
      session.buffer.shift();
    }
    session.lastActivityAt = Date.now();

    pendingBroadcast += data;

    // If pending exceeds 128KB, flush immediately instead of waiting for microtask
    if (pendingBroadcast.length > MAX_BROADCAST_PENDING && broadcastScheduled) {
      const batch = pendingBroadcast;
      pendingBroadcast = "";
      for (const ws of session.clients) {
        try { ws.send(batch); } catch { /* dead socket */ }
      }
      return;
    }

    if (!broadcastScheduled) {
      broadcastScheduled = true;
      queueMicrotask(() => {
        const batch = pendingBroadcast;
        pendingBroadcast = "";
        broadcastScheduled = false;
        for (const ws of session.clients) {
          try {
            ws.send(batch);
          } catch {
            /* dead socket */
          }
        }
      });
    }
  });

  proc.onExit(() => {
    for (const ws of session.clients) {
      try {
        ws.send("\r\n\x1b[33m[process exited]\x1b[0m\r\n");
      } catch {
        /* ignore */
      }
    }
    // Only persist if the session is still in the map — if it was explicitly
    // deleted via DELETE /sessions/:id, it's already been removed and the DB
    // row cleared. Re-persisting here would resurrect the deleted row.
    if (sessions.has(id)) {
      persistSession(session);
      sessions.delete(id);
    }
  });

  sessions.set(id, session);
  // Persist immediately so the session survives a crash within the first 30s
  persistSession(session);
  return session;
}

// Idle session sweeper — runs every 15 minutes
setInterval(() => {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (
      session.clients.size === 0 &&
      now - session.lastActivityAt > SESSION_IDLE_TTL_MS
    ) {
      try {
        session.proc.kill();
      } catch {
        /* ignore */
      }
      sessions.delete(id);
      deletePersistedSessionStmt.run(id);
    }
  }
  // Also sweep recovered sessions that nobody reconnected to
  for (const [id, meta] of recoveredSessions) {
    if (now - meta.lastActivityAt > SESSION_IDLE_TTL_MS) {
      recoveredSessions.delete(id);
      deletePersistedSessionStmt.run(id);
    }
  }
}, 15 * 60 * 1000);

// Periodic session persistence — flush active sessions to DB every 30s
setInterval(persistAllSessions, 30_000);

// ── Hono app ──────────────────────────────────────────────────────────────────

const app = new Hono();
const { injectWebSocket, upgradeWebSocket, wss } = createNodeWebSocket({ app });

// Enable permessage-deflate compression so Safari's NSURLSession WebSocket works.
// Safari requests compression via Sec-WebSocket-Extensions but assumes it's active
// even when the server rejects it, corrupting all frames. Enabling it server-side
// satisfies Safari's expectation. Must be an object (not `true`) because the ws
// library normalizes boolean→object only in the constructor, not when set later.
wss.options.perMessageDeflate = {};

// ── Backup terminal HTML (self-contained UI served at GET /) ────────────────

const BACKUP_TERMINAL_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Talome Terminal</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/css/xterm.min.css">
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#0d1117;color:#e6edf3;font-family:-apple-system,system-ui,sans-serif;height:100vh;display:flex;flex-direction:column;overflow:hidden}
#header{display:flex;align-items:center;gap:12px;padding:8px 16px;background:#161b22;border-bottom:1px solid rgba(255,255,255,0.08);flex-shrink:0}
#header h1{font-size:14px;font-weight:500;opacity:0.7}
#session-select{background:#21262d;color:#e6edf3;border:1px solid rgba(255,255,255,0.1);border-radius:6px;padding:4px 8px;font-size:13px;outline:none}
#status{margin-left:auto;display:flex;align-items:center;gap:6px;font-size:12px}
#status-dot{width:8px;height:8px;border-radius:50%;background:#3fb950}
#status-text{opacity:0.6}
button{background:#21262d;color:#e6edf3;border:1px solid rgba(255,255,255,0.1);border-radius:6px;padding:4px 12px;font-size:12px;cursor:pointer}
button:hover{background:#30363d}
#terminal-container{flex:1;padding:4px}
#auth-overlay{position:fixed;inset:0;background:rgba(0,0,0,0.85);display:flex;align-items:center;justify-content:center;z-index:100}
#auth-box{background:#161b22;border:1px solid rgba(255,255,255,0.1);border-radius:12px;padding:32px;width:340px;text-align:center}
#auth-box h2{font-size:18px;font-weight:500;margin-bottom:8px}
#auth-box p{font-size:13px;opacity:0.6;margin-bottom:20px}
#auth-box input{width:100%;background:#0d1117;color:#e6edf3;border:1px solid rgba(255,255,255,0.15);border-radius:6px;padding:10px 12px;font-size:14px;outline:none;margin-bottom:12px}
#auth-box input:focus{border-color:rgba(255,255,255,0.3)}
#auth-error{color:#f85149;font-size:12px;margin-bottom:8px;min-height:18px}
#auth-box button{width:100%;padding:10px;font-size:14px}
</style>
</head>
<body>
<div id="header">
  <h1>Talome Terminal</h1>
  <select id="session-select"><option value="">Loading…</option></select>
  <button id="new-session-btn" title="New session">+ New</button>
  <div id="status"><span id="status-dot"></span><span id="status-text">connecting</span></div>
  <button id="reconnect-btn" style="display:none">Reconnect</button>
</div>
<div id="terminal-container"></div>
<div id="auth-overlay" style="display:none">
  <div id="auth-box">
    <h2 id="auth-title">Terminal Access</h2>
    <p id="auth-desc">Enter password to continue</p>
    <input type="password" id="auth-input" placeholder="Password" autocomplete="off">
    <div id="auth-error"></div>
    <button id="auth-submit">Connect</button>
  </div>
</div>
<script src="https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/lib/xterm.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/@xterm/addon-fit@0.10.0/lib/addon-fit.min.js"></script>
<script>
(function(){
  const HAS_PASSWORD = __HAS_PASSWORD__;
  const BASE = location.origin;
  const WS_URL = location.origin.replace(/^http/,'ws') + '/ws';
  let token = sessionStorage.getItem('talome_backup_token');
  let ws = null;
  let term = null;
  let fitAddon = null;
  let currentSession = null;
  let reconnectAttempts = 0;
  const MAX_RECONNECT = 15;

  const isLocalhost = ['127.0.0.1','localhost','::1'].includes(location.hostname);

  // Auth
  async function authenticate(password) {
    const endpoint = HAS_PASSWORD ? '/backup-auth' : '/backup-auth/setup';
    const res = await fetch(BASE + endpoint, {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({password})
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Auth failed');
    token = data.token;
    sessionStorage.setItem('talome_backup_token', token);
    return token;
  }

  function showAuth() {
    const overlay = document.getElementById('auth-overlay');
    overlay.style.display = 'flex';
    const title = document.getElementById('auth-title');
    const desc = document.getElementById('auth-desc');
    if (!HAS_PASSWORD) {
      title.textContent = 'Set Terminal Password';
      desc.textContent = 'Create a password for remote terminal access';
    }
    document.getElementById('auth-input').focus();
  }

  document.getElementById('auth-submit').onclick = async () => {
    const pw = document.getElementById('auth-input').value;
    const err = document.getElementById('auth-error');
    err.textContent = '';
    try {
      await authenticate(pw);
      document.getElementById('auth-overlay').style.display = 'none';
      init();
    } catch(e) { err.textContent = e.message; }
  };
  document.getElementById('auth-input').onkeydown = (e) => {
    if (e.key === 'Enter') document.getElementById('auth-submit').click();
  };

  // Terminal
  function initTerminal() {
    if (term) { term.dispose(); }
    term = new window.Terminal({
      fontFamily: '"SF Mono","Menlo","Monaco","Courier New",monospace',
      fontSize: 13,
      theme: {background:'#0d1117',foreground:'#e6edf3',cursor:'#58a6ff',selectionBackground:'rgba(56,139,253,0.3)'},
      allowProposedApi: true,
      cursorBlink: true,
    });
    fitAddon = new window.FitAddon.FitAddon();
    term.loadAddon(fitAddon);
    term.open(document.getElementById('terminal-container'));
    fitAddon.fit();
    term.onData(data => {
      if (ws && ws.readyState === 1) ws.send(JSON.stringify({type:'input',data}));
    });
  }

  let currentStatus = '';
  function setStatus(state) {
    if (state === currentStatus) return;
    currentStatus = state;
    const dot = document.getElementById('status-dot');
    const text = document.getElementById('status-text');
    const btn = document.getElementById('reconnect-btn');
    dot.style.background = state === 'connected' ? '#3fb950' : state === 'reconnecting' ? '#d29922' : '#f85149';
    text.textContent = state;
    btn.style.display = state === 'disconnected' ? '' : 'none';
  }

  function connect() {
    if (ws) { try { ws.close(); } catch {} }
    setStatus('connecting');
    ws = new WebSocket(WS_URL);
    ws.onopen = () => {
      setStatus('connected');
      reconnectAttempts = 0;
      ws.send(JSON.stringify({ type: 'auth', token: token || '', sessionId: currentSession }));
    };
    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === 'output' || msg.data) {
          term.write(msg.data || msg.output || '');
        } else if (msg.type === 'error') {
          term.write('\\r\\n\\x1b[31m' + (msg.message || 'Connection error') + '\\x1b[0m\\r\\n');
        }
      } catch {
        term.write(e.data);
      }
    };
    ws.onclose = (e) => {
      if (e.code === 1008) {
        sessionStorage.removeItem('talome_backup_token');
        token = null;
        showAuth();
        return;
      }
      if (reconnectAttempts < MAX_RECONNECT) {
        setStatus('reconnecting');
        const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 30000);
        reconnectAttempts++;
        setTimeout(connect, delay);
      } else {
        setStatus('disconnected');
      }
    };
    ws.onerror = () => {};
  }

  // Sessions
  async function loadSessions() {
    try {
      const res = await fetch(BASE + '/sessions');
      const data = await res.json();
      const select = document.getElementById('session-select');
      select.innerHTML = '<option value="">Default</option>';
      (data.sessions || []).forEach(s => {
        const opt = document.createElement('option');
        opt.value = s.id;
        opt.textContent = (s.displayName || s.name) + (s.clients > 0 ? ' ●' : '');
        if (s.id === currentSession) opt.selected = true;
        select.appendChild(opt);
      });
    } catch {}
  }

  document.getElementById('session-select').onchange = (e) => {
    currentSession = e.target.value || null;
    reconnectAttempts = 0;
    if (term) term.clear();
    connect();
  };

  document.getElementById('new-session-btn').onclick = async () => {
    const name = prompt('Session name:');
    if (!name) return;
    try {
      const res = await fetch(BASE + '/sessions', {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({name})
      });
      const data = await res.json();
      currentSession = data.sessionId;
      await loadSessions();
      reconnectAttempts = 0;
      connect();
    } catch {}
  };

  document.getElementById('reconnect-btn').onclick = () => {
    reconnectAttempts = 0;
    connect();
  };

  window.addEventListener('resize', () => { if (fitAddon) { fitAddon.fit(); if (ws && ws.readyState === 1 && term) ws.send(JSON.stringify({type:'resize',cols:term.cols,rows:term.rows})); } });

  function init() {
    initTerminal();
    loadSessions();
    connect();
    setInterval(loadSessions, 15000);
  }

  // Entry point
  if (isLocalhost || token) {
    init();
  } else if (!HAS_PASSWORD) {
    showAuth();
  } else {
    // Try existing token
    fetch(BASE + '/health').then(r => {
      if (r.ok && token) init();
      else showAuth();
    }).catch(() => showAuth());
  }
})();
</script>
</body>
</html>`;

app.use("*", cors({ origin: (origin) => origin ?? "*", credentials: true }));

// ── Routes ────────────────────────────────────────────────────────────────────

// Backup terminal UI — self-contained HTML page served directly by the daemon
app.get("/", (c) => {
  const hasPassword = !!sqlite.prepare("SELECT value FROM daemon_auth WHERE key = 'password_hash'").get();
  return c.html(BACKUP_TERMINAL_HTML.replace("__HAS_PASSWORD__", String(hasPassword)));
});

// ── Backup auth routes ──────────────────────────────────────────────────

app.post("/backup-auth/setup", async (c) => {
  const existing = sqlite.prepare("SELECT value FROM daemon_auth WHERE key = 'password_hash'").get() as { value: string } | undefined;
  if (existing) return c.json({ error: "Password already set. Use the dashboard to change it." }, 400);
  const { password } = await c.req.json<{ password: string }>();
  if (!password || password.length < 4) return c.json({ error: "Password must be at least 4 characters" }, 400);
  const hash = createHash("sha256").update(password).digest("hex");
  sqlite.prepare("INSERT OR REPLACE INTO daemon_auth (key, value) VALUES ('password_hash', ?)").run(hash);
  return c.json({ ok: true });
});

app.post("/backup-auth", async (c) => {
  const ip = c.req.header("x-forwarded-for") || "unknown";
  const attempt = authAttempts.get(ip);
  if (attempt && attempt.blockedUntil > Date.now()) {
    return c.json({ error: "Too many attempts. Try again later." }, 429);
  }

  const { password } = await c.req.json<{ password: string }>();
  const stored = sqlite.prepare("SELECT value FROM daemon_auth WHERE key = 'password_hash'").get() as { value: string } | undefined;
  if (!stored) return c.json({ error: "No password set. POST to /backup-auth/setup first." }, 400);

  const hash = createHash("sha256").update(password).digest("hex");
  if (hash !== stored.value) {
    const prev = authAttempts.get(ip) || { count: 0, blockedUntil: 0 };
    prev.count++;
    if (prev.count >= 5) prev.blockedUntil = Date.now() + 5 * 60 * 1000;
    authAttempts.set(ip, prev);
    return c.json({ error: "Invalid password" }, 401);
  }

  authAttempts.delete(ip);
  const token = `backup_${randomUUID().replace(/-/g, "")}`;
  backupAuthTokens.set(token, Date.now() + 4 * 60 * 60 * 1000);
  return c.json({ token, bootId: BOOT_ID });
});

// Generate ephemeral auth token — called by the main server proxy
app.post("/session", (c) => {
  const token = createEphemeralToken();
  return c.json({ token, expiresAt: Date.now() + 60_000, bootId: BOOT_ID });
});

app.get("/project-root", (c) => {
  return c.json({ path: PROJECT_ROOT });
});

// List active sessions (includes recovered sessions awaiting reconnection)
app.get("/sessions", (c) => {
  const list: {
    id: string;
    name: string;
    displayName?: string;
    clients: number;
    createdAt: number;
    lastActivityAt: number;
    uptime: number;
    recovered: boolean;
  }[] = [];

  // Active sessions
  for (const s of sessions.values()) {
    list.push({
      id: s.id,
      name: s.name,
      displayName: s.displayName,
      clients: s.clients.size,
      createdAt: s.createdAt,
      lastActivityAt: s.lastActivityAt,
      uptime: Date.now() - s.createdAt,
      recovered: false,
    });
  }

  // Recovered sessions (not yet reconnected — show them so users can select them)
  for (const [id, meta] of recoveredSessions) {
    if (!sessions.has(id)) {
      list.push({
        id,
        name: meta.name,
        displayName: meta.displayName,
        clients: 0,
        createdAt: meta.createdAt,
        lastActivityAt: meta.lastActivityAt,
        uptime: Date.now() - meta.createdAt,
        recovered: true,
      });
    }
  }

  return c.json({ sessions: list });
});

// Create / retrieve a named session
app.post("/sessions", async (c) => {
  const { name = "default", displayName } = await c.req
    .json<{ name?: string; displayName?: string }>()
    .catch(() => ({ name: "default", displayName: undefined }));
  const safeId = name.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 40);
  const id = `sess_${safeId}`;
  const exists = sessions.has(id) || recoveredSessions.has(id);

  // Store displayName on existing, recovered, or pending session
  const existing = sessions.get(id);
  if (existing && displayName) {
    existing.displayName = displayName;
  } else if (recoveredSessions.has(id) && displayName) {
    recoveredSessions.get(id)!.displayName = displayName;
  } else if (!existing && displayName) {
    pendingDisplayNames.set(id, displayName);
  }
  return c.json({ sessionId: id, name: safeId, displayName, exists });
});

// Update session display name (accepts PATCH even if PTY hasn't spawned yet)
app.patch("/sessions/:id", async (c) => {
  const id = c.req.param("id");
  const { displayName } = await c.req
    .json<{ displayName?: string }>()
    .catch(() => ({ displayName: undefined }));
  if (!displayName) return c.json({ ok: true });
  const session = sessions.get(id);
  if (session) {
    session.displayName = displayName;
  } else if (recoveredSessions.has(id)) {
    recoveredSessions.get(id)!.displayName = displayName;
  } else {
    // Session not created yet (WS hasn't connected) — store for later
    pendingDisplayNames.set(id, displayName);
  }
  return c.json({ ok: true });
});

// Kill a named session
app.delete("/sessions/:id", (c) => {
  const id = c.req.param("id");
  const session = sessions.get(id);
  const wasRecovered = recoveredSessions.has(id);

  if (!session && !wasRecovered)
    return c.json({ error: "Session not found" }, 404);

  if (session) {
    try {
      session.proc.kill();
    } catch {
      /* ignore */
    }
    sessions.delete(id);
  }
  recoveredSessions.delete(id);
  deletePersistedSessionStmt.run(id);

  return c.json({ success: true });
});

// Health — lets the main server check if the daemon is up
app.get("/health", (c) =>
  c.json({
    ok: true,
    sessions: sessions.size,
    recoverable: recoveredSessions.size,
    bootId: BOOT_ID,
  }),
);

// ── Image upload for terminal paste/drop ─────────────────────────────────────
// Saves uploaded image to ~/.talome/terminal-uploads/ and returns the path
// so the frontend can inject it into the PTY stdin for Claude Code.
const UPLOAD_DIR = join(homedir(), ".talome", "terminal-uploads");
mkdirSync(UPLOAD_DIR, { recursive: true });

app.post("/upload", async (c) => {
  const body = await c.req.parseBody();
  const file = body.file;
  if (!(file instanceof File)) {
    return c.json({ error: "No file provided" }, 400);
  }

  const ext = file.name.split(".").pop() || "png";
  const filename = `${Date.now()}-${randomUUID().slice(0, 8)}.${ext}`;
  const filePath = join(UPLOAD_DIR, filename);

  const buf = Buffer.from(await file.arrayBuffer());
  writeFileSync(filePath, buf);

  return c.json({ path: filePath });
});

// WebSocket endpoint
app.get(
  "/ws",
  upgradeWebSocket(() => {
    let session: PtySession | undefined;
    let authenticated = false;

    return {
      onOpen() {
        // Auth via first message — browser WS API cannot set custom headers
      },
      onMessage(event, ws) {
        try {
          const msg = JSON.parse(String(event.data)) as {
            type: "auth" | "input" | "resize";
            token?: string;
            sessionId?: string;
            sessionName?: string;
            data?: string;
            cols?: number;
            rows?: number;
          };

          if (!authenticated) {
            if (msg.type !== "auth" || !msg.token) {
              ws.send("\r\n\x1b[31mAuthentication required\x1b[0m\r\n");
              ws.close(1008, "Authentication required");
              return;
            }

            const validEphemeral = verifyEphemeralToken(msg.token);
            const validBackup = !validEphemeral && msg.token ? verifyBackupToken(msg.token) : false;
            const validMcp =
              !validEphemeral && !validBackup && verifyBearerToken(`Bearer ${msg.token}`);

            if (!validEphemeral && !validBackup && !validMcp) {
              ws.send("\r\n\x1b[31mInvalid token\x1b[0m\r\n");
              ws.close(1008, "Invalid token");
              return;
            }

            authenticated = true;

            if (msg.sessionId) {
              try {
                session = getOrCreateSession(
                  msg.sessionId,
                  msg.sessionName ?? msg.sessionId,
                );
                session.clients.add(ws);
                // Always replay buffer — even for new sessions the PTY may have
                // emitted the shell prompt before the client was added.
                if (session.buffer.length > 0) {
                  ws.send(session.buffer.join(""));
                }
              } catch (spawnErr) {
                ws.send(
                  `\r\n\x1b[31mFailed to spawn shell: ${spawnErr instanceof Error ? spawnErr.message : String(spawnErr)}\x1b[0m\r\n`,
                );
                ws.close();
              }
            } else {
              try {
                const ephemeralId = `eph_${randomUUID().replace(/-/g, "")}`;
                session = getOrCreateSession(ephemeralId, "ephemeral");
                session.clients.add(ws);
              } catch (spawnErr) {
                ws.send(
                  `\r\n\x1b[31mFailed to spawn shell: ${spawnErr instanceof Error ? spawnErr.message : String(spawnErr)}\x1b[0m\r\n`,
                );
                ws.close();
              }
            }

            return;
          }

          if (!session) return;

          if (msg.type === "input" && msg.data) {
            session.proc.write(msg.data);
            session.lastActivityAt = Date.now();
          }
          if (msg.type === "resize" && msg.cols && msg.rows) {
            session.proc.resize(msg.cols, msg.rows);
            session.cols = msg.cols;
            session.rows = msg.rows;
          }
        } catch {
          // Ignore malformed messages
        }
      },
      onClose(_evt, ws) {
        if (!session) return;
        session.clients.delete(ws);
        if (session.id.startsWith("eph_") && session.clients.size === 0) {
          try {
            session.proc.kill();
          } catch {
            /* ignore */
          }
          sessions.delete(session.id);
          deletePersistedSessionStmt.run(session.id);
        } else if (session.clients.size === 0) {
          // Last client disconnected from a persistent session — flush to DB
          // so state is recoverable if the daemon restarts before the next
          // periodic flush.
          persistSession(session);
        }
      },
    };
  }),
);

// ── Start ─────────────────────────────────────────────────────────────────────

const server = serve(
  { fetch: app.fetch, port: DAEMON_PORT, hostname: "0.0.0.0" },
  () => {
    console.log(`[terminal-daemon] Running on :${DAEMON_PORT}`);
    writePidFile();
  },
);

injectWebSocket(server);

// Graceful shutdown — persist all sessions, then kill PTY processes cleanly
function shutdown() {
  cleanupPidFile();
  persistAllSessions();
  for (const session of sessions.values()) {
    try {
      session.proc.kill();
    } catch {
      /* ignore */
    }
  }
  sqlite.close();
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
