# Talome Backend Architectural Audit

**Date:** 2026-03-23
**Scope:** `apps/core/` — resilience, decoupling, resource optimization
**Status:** Research & recommendations (no code changes)

---

## Table of Contents

1. [Current Architecture](#1-current-architecture)
2. [Transcoding Service Decoupling](#2-transcoding-service-decoupling)
3. [Terminal Session Resilience](#3-terminal-session-resilience)
4. [Service Architecture Refactoring](#4-service-architecture-refactoring)
5. [Resource Optimization for Low-End Hardware](#5-resource-optimization-for-low-end-hardware)
6. [Best Practices Research](#6-best-practices-research)
7. [Migration Strategy](#7-migration-strategy)

---

## 1. Current Architecture

### 1.1 System Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                        apps/dashboard/                          │
│                     Next.js 15 (port 3000)                      │
│   ┌──────────┐  ┌─────────┐  ┌──────────┐  ┌───────────────┐   │
│   │ Dashboard │  │  Chat   │  │ Terminal │  │   App Store   │   │
│   │ Widgets   │  │   UI    │  │   Page   │  │               │   │
│   └────┬─────┘  └────┬────┘  └────┬─────┘  └───────┬───────┘   │
└────────┼─────────────┼───────────┼──────────────────┼───────────┘
         │ HTTP        │ SSE      │ WS (direct)      │ HTTP
         │             │          │                   │
┌────────┼─────────────┼──────────┼───────────────────┼───────────┐
│        ▼             ▼          │                   ▼            │
│  ┌──────────────────────────────┼──────────────────────────┐    │
│  │          apps/core/ (port 4000)                         │    │
│  │  ┌──────────┐ ┌──────────┐  │  ┌──────────┐            │    │
│  │  │  Hono    │ │ AI Agent │  │  │ Monitor  │            │    │
│  │  │  Routes  │ │ + Tools  │  │  │  (60s)   │            │    │
│  │  │ (45 grp) │ │(100+ tls)│  │  │          │            │    │
│  │  └────┬─────┘ └────┬─────┘  │  └────┬─────┘            │    │
│  │       │             │        │       │                   │    │
│  │  ┌────▼─────────────▼────────┼───────▼──────────────┐   │    │
│  │  │         Shared Services                          │   │    │
│  │  │  ┌─────────┐  ┌──────────┤  ┌────────────────┐  │   │    │
│  │  │  │ SQLite  │  │ Docker   │  │ Media Optimizer│  │   │    │
│  │  │  │ (Drizzle│  │ (dockerod│  │  (ffmpeg jobs) │  │   │    │
│  │  │  │  + WAL) │  │  e)      │  │                │  │   │    │
│  │  │  └─────────┘  └──────────┤  └────────────────┘  │   │    │
│  │  │  ┌─────────┐  ┌─────────┤  ┌────────────────┐  │   │    │
│  │  │  │ Agent   │  │ Automati│  │ Messaging      │  │   │    │
│  │  │  │ Loop    │  │ on Engin│  │ (Telegram,     │  │   │    │
│  │  │  │ (3-tier)│  │ e       │  │  Discord)      │  │   │    │
│  │  │  └─────────┘  └─────────┘  └────────────────┘  │   │    │
│  │  └──────────────────────────────────────────────────┘   │    │
│  └─────────────────────────────────────────────────────────┘    │
│                             │                                    │
│  ┌──────────────────────────┼───────────────────────────────┐   │
│  │   Terminal Daemon (port 4001) — separate process         │   │
│  │   ┌────────────┐  ┌─────▼──────┐  ┌──────────────────┐  │   │
│  │   │  node-pty   │  │  WebSocket │  │ SQLite sessions  │  │   │
│  │   │  sessions   │  │  server    │  │ (scroll buffer)  │  │   │
│  │   └────────────┘  └────────────┘  └──────────────────┘  │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │   MCP Server (stdio) — spawned by Claude Code           │   │
│  │   All 100+ tools available                               │   │
│  └──────────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────┘
         │                    │                    │
         ▼                    ▼                    ▼
┌──────────────┐  ┌────────────────┐  ┌─────────────────────┐
│ Docker Socket│  │ External APIs  │  │   File System       │
│ /var/run/    │  │ Sonarr, Radarr │  │ /media, /tmp/talome │
│ docker.sock  │  │ Jellyfin, etc. │  │                     │
└──────────────┘  └────────────────┘  └─────────────────────┘
```

### 1.2 Process Model

| Process | Port | Lifecycle | Purpose |
|---------|------|-----------|---------|
| Core Server | 4000 | Main process | HTTP API, AI agent, background services |
| Terminal Daemon | 4001 | Child of core (prod) / standalone (dev) | PTY management, WebSocket |
| MCP Server | stdio | Spawned by Claude Code | Tool access for Claude Code |
| FFmpeg workers | N/A | Spawned per transcode job | HLS streaming, optimization |

### 1.3 Background Services (all in core process)

| Service | Interval | Cost | Purpose |
|---------|----------|------|---------|
| Monitor | 60s | High (Docker API + subprocess) | Container health, disk, updates |
| Agent Loop | 60s | Variable (3-tier AI) | Event detection + remediation |
| Automation Cron | 60s | Low | Schedule trigger checks |
| HLS Idle Reaper | 15s | Low (in-memory map scan) | Kill abandoned HLS jobs |
| Orphan Recovery | 60s | Low | Reattach stuck optimization jobs |
| Auto-Optimize | 30min | Medium (file scanning) | Library optimization scheduling |
| Session Persistence | 30s (daemon) | Low | Flush terminal sessions to DB |
| Session Cleanup | 15min (daemon) | Low | Sweep idle terminal sessions |
| Stats Stream | 2s (per client) | High (subprocess) | Real-time system metrics |
| Digest Scheduler | configurable | Low | Email digests |
| Activity Summary | 1hr | Low | Activity summaries |
| DNS Watcher | 60s | Low | IP change detection |
| Conversation Pruner | 30s | Low | Expire ephemeral tokens |

### 1.4 Data Stores

| Store | Technology | Usage |
|-------|-----------|-------|
| Primary DB | SQLite + WAL + Drizzle ORM | 30+ tables, all state |
| Terminal sessions | Same SQLite (shared by daemon) | Scroll buffers, metadata |
| HLS cache | Filesystem (`/tmp/talome/hls`) | Transcoded segments |
| Transmux cache | Filesystem (`/tmp/talome-transmux`) | Remuxed files |
| Optimization temp | Filesystem (`.tmp.mp4` files) | In-progress conversions |
| Docker state | Docker daemon | Container lifecycle |
| App configs | Filesystem (`~/.talome/`) | Generated apps, user apps |

---

## 2. Transcoding Service Decoupling

### 2.1 Current State

Transcoding spans **three subsystems** tightly coupled to the core server:

| Subsystem | Location | State Management | Process Model |
|-----------|----------|------------------|---------------|
| **HLS Streaming** | `routes/files.ts:370-845` | In-memory `Map<string, HlsJob>` | ffmpeg child processes (max 5) |
| **Library Optimization** | `media/optimizer.ts` (1176 lines) | SQLite `optimization_jobs` table | ffmpeg child processes (configurable) |
| **Transmux** | `routes/files.ts:847-1040` | In-memory `Map<string, TransmuxJob>` | ffmpeg child processes |

**Tight couplings identified:**

1. HLS and transmux jobs are **in-memory Maps** — lost on core restart
2. HLS idle reaper runs in core's event loop (15s interval)
3. Optimization queue processor (`processQueue()`) runs in core's event loop
4. Optimization triggers Radarr/Sonarr rescan via direct HTTP calls from core
5. Hardware acceleration detection (`detectHwEncoder()`) uses `execSync` at module load
6. `probeFile()` / `probeFileAsync()` used by all three subsystems
7. AI tools (`optimization-tools.ts`) directly call optimizer functions
8. Startup/shutdown hooks in `index.ts` manage HLS cleanup and auto-optimize

### 2.2 Proposed Architecture

```
┌──────────────────────────────────┐     ┌──────────────────────────────┐
│       Core Server (port 4000)    │     │   Transcoding Service        │
│                                  │     │   (port 4002 or IPC)         │
│  ┌────────────────────────────┐  │     │                              │
│  │ /api/optimization/*       │──┼──►  │  ┌────────────────────────┐  │
│  │ /api/files/hls-*          │  │ REST│  │  Job Queue (BullMQ)    │  │
│  │ /api/files/transmux-*     │  │     │  │  ┌──────┐  ┌────────┐ │  │
│  └────────────────────────────┘  │     │  │  │HLS Q │  │Optim Q │ │  │
│                                  │     │  │  └──────┘  └────────┘ │  │
│  ┌────────────────────────────┐  │     │  │  ┌──────┐             │  │
│  │ AI Tools (proxy layer)    │──┼──►  │  │  │Tmux Q│             │  │
│  │ optimization-tools.ts     │  │ REST│  │  └──────┘             │  │
│  └────────────────────────────┘  │     │  └────────────────────────┘  │
│                                  │     │                              │
│  ┌────────────────────────────┐  │     │  ┌────────────────────────┐  │
│  │ HLS segment serving       │  │     │  │  FFmpeg Workers        │  │
│  │ (static file server for   │  │     │  │  (child processes)     │  │
│  │  /tmp/talome/hls/*)       │  │     │  │  ┌─────┐ ┌─────┐      │  │
│  └────────────────────────────┘  │     │  │  │ W1  │ │ W2  │ ... │  │
│                                  │     │  │  └─────┘ └─────┘      │  │
└──────────────────────────────────┘     │  └────────────────────────┘  │
                                         │                              │
                                         │  ┌────────────────────────┐  │
                                         │  │  State Management      │  │
                                         │  │  - SQLite (jobs table) │  │
                                         │  │  - Redis (BullMQ)      │  │
                                         │  │  - Filesystem (cache)  │  │
                                         │  └────────────────────────┘  │
                                         │                              │
                                         │  ┌────────────────────────┐  │
                                         │  │  Callbacks             │  │
                                         │  │  - POST /hook/complete │  │
                                         │  │    → core triggers     │  │
                                         │  │      Radarr rescan     │  │
                                         │  └────────────────────────┘  │
                                         └──────────────────────────────┘
```

### 2.3 IPC Mechanism Evaluation

| Mechanism | Pros | Cons | Recommendation |
|-----------|------|------|----------------|
| **REST API (HTTP)** | Simple, debuggable, language-agnostic | Connection overhead per request | **Recommended for job submission + status** |
| **gRPC** | Typed contracts, streaming, fast | Overkill for this use case, protobuf complexity | Not recommended |
| **Message Queue (Redis/BullMQ)** | Durable, retry, fan-out, backpressure | Requires Redis dependency | **Recommended for job execution** |
| **IPC (child_process)** | Zero network overhead, fast | Couples processes, no persistence | Fallback for lightweight mode |
| **Unix Domain Socket** | Fast local, no TCP overhead | Custom protocol needed | Not recommended |

**Recommended hybrid approach:** REST API for control plane (submit, cancel, status, config) + BullMQ/Redis for data plane (job queue, progress events, completion callbacks).

### 2.4 Service Interface Contract

#### Job Submission

```typescript
// POST /api/transcode/jobs
interface TranscodeJobRequest {
  type: "hls" | "optimize" | "transmux";
  sourcePath: string;
  // HLS-specific
  audioTrack?: number;
  seekTo?: number;
  transcodeVideo?: boolean;
  // Optimize-specific
  keepOriginal?: boolean;
  priority?: number;
  // Transmux-specific (no extra options)
}

interface TranscodeJobResponse {
  id: string;
  hash: string; // for HLS segment retrieval
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  progress: number; // 0.0 - 1.0
  estimatedTimeRemaining?: number; // seconds
}
```

#### Job Status / Progress

```typescript
// GET /api/transcode/jobs/:id
// GET /api/transcode/jobs?type=optimize&status=running

// SSE: GET /api/transcode/jobs/:id/progress
// Event stream: { progress: 0.45, fps: 30, speed: "2.1x", eta: 120 }
```

#### Completion Webhook

```typescript
// POST callback to core server
interface TranscodeCompletionEvent {
  jobId: string;
  type: "hls" | "optimize" | "transmux";
  status: "completed" | "failed";
  sourcePath: string;
  targetPath?: string;
  outputSize?: number;
  duration: number; // processing time in seconds
  error?: string;
}
// Core handles: Radarr/Sonarr rescan, notification, scan cache update
```

#### Probe / Analyze

```typescript
// POST /api/transcode/probe
interface ProbeRequest { path: string; }
interface ProbeResponse {
  duration: number;
  videoCodec: string;
  audioTracks: Array<{ index: number; codec: string; language: string; channels: number }>;
  needsOptimization: boolean;
  reason?: string;
  canTransmux: boolean;
}
```

### 2.5 Data Flow — Decoupled Optimization

```
User/Auto Scan → Core: POST /api/optimization/scan
  ↓
Core probes files (or delegates to transcoding service)
  ↓
Core: POST /api/transcode/jobs (type: optimize)
  ↓
Transcoding Service: Enqueue in BullMQ "optimize" queue
  ↓
Worker picks job → spawns ffmpeg → streams progress to BullMQ
  ↓
Core: SSE /api/transcode/jobs/:id/progress → Frontend progress bar
  ↓
Worker completes → atomic rename .tmp.mp4 → target.mp4
  ↓
Transcoding Service: POST /hook/complete → Core
  ↓
Core: triggers Radarr/Sonarr rescan, updates scan cache, sends notification
```

### 2.6 Data Flow — Decoupled HLS Streaming

```
Client → Core: GET /api/files/hls-start?path=...
  ↓
Core: POST /api/transcode/jobs (type: hls)
  ↓
Transcoding Service: Spawn ffmpeg, write segments to /tmp/talome/hls/<hash>/
  ↓
Core: serves segments as static files: GET /hls/<hash>/playlist.m3u8
  ↓
Client: fetches segments directly from Core (or from transcoding service)
  ↓
Core: POST /api/transcode/ping (resets idle timer)
  ↓
Transcoding Service: idle reaper kills after 90s inactivity
```

### 2.7 Redis Dependency Consideration

Introducing Redis as a hard dependency conflicts with Talome's "single binary, no external deps" ethos. Options:

| Option | Tradeoff |
|--------|----------|
| **A. BullMQ + Redis** | Best queue semantics, but adds Redis process |
| **B. SQLite-backed queue (current)** | No new deps, but less mature queue semantics |
| **C. BullMQ + embedded KeyDB** | Redis-compatible, can bundle as sidecar |
| **D. Hybrid: SQLite for optimize, in-memory for HLS** | Matches current model, least disruptive |

**Recommendation:** Start with **Option D** (least disruptive) — extract transcoding into its own process using the existing SQLite job table for optimization and in-memory maps for ephemeral HLS/transmux. Upgrade to BullMQ + Redis only if queue reliability becomes an issue at scale.

---

## 3. Terminal Session Resilience

### 3.1 Current State — Already Strong

Talome's terminal architecture is **already well-decoupled**. The terminal daemon (`terminal-daemon.ts`, 653 lines) runs as a separate process with:

| Feature | Implementation | Status |
|---------|---------------|--------|
| Separate process | Child process of core (prod), standalone (dev) | Done |
| Session persistence | SQLite (`terminal_sessions` table) | Done |
| Scroll buffer replay | 500-line FIFO, replayed on reconnect | Done |
| Daemon restart detection | `bootId` comparison in frontend | Done |
| Idle session cleanup | 4-hour TTL, swept every 15 min | Done |
| Periodic persistence | Flush to DB every 30s | Done |
| Graceful shutdown | Persist all sessions, kill PTYs on SIGTERM | Done |
| Reconnection | Exponential backoff: 1s→2s→4s→8s→10s (5 attempts) | Done |
| Auth | Ephemeral tokens (60s TTL) + Bearer tokens (MCP) | Done |
| Output batching | Microtask coalescing (server) + RAF buffering (client/Safari) | Done |
| Display name sync | AI-generated, stored in DB + daemon PATCH | Done |

### 3.2 Current Gaps

| Gap | Impact | Severity |
|-----|--------|----------|
| PTY processes die with daemon | Reconnect gets new shell, loses running commands | Medium |
| No tmux integration for daemon sessions | Can't reattach to running processes after restart | Medium |
| Daemon is child of core in production | Core crash kills daemon (SIGTERM cascade) | Low-Medium |
| No persistent process supervisor | Daemon doesn't auto-restart if it crashes independently | Low |
| WebSocket direct from browser | No reverse proxy, bypasses core auth on reconnect | Low |

### 3.3 Recommended Improvements

#### Priority 1: Decouple daemon from core process tree

**Current:** Core spawns daemon as child process → daemon dies if core crashes.

**Proposed:** Daemon runs independently via systemd/launchd/PM2, or as a `detached` child:

```typescript
// In index.ts — change from:
spawn(process.execPath, [daemonScript], { stdio: ["ignore", "inherit", "inherit"] });

// To:
spawn(process.execPath, [daemonScript], {
  stdio: "ignore",
  detached: true,     // survives parent exit
  env: { ...process.env },
}).unref();            // don't keep parent alive
```

This alone ensures the daemon survives core crashes while keeping the simple startup model.

#### Priority 2: tmux-backed sessions for long-running work

For Evolution runs and Claude Code sessions (which can take 10+ minutes), wrap PTY commands in tmux:

```typescript
// Instead of: pty.spawn("/bin/bash", ["-c", command])
// Use: pty.spawn("tmux", ["new-session", "-A", "-s", sessionId, command])
```

This gives process persistence across daemon restarts. The daemon already handles scroll buffer replay; tmux adds process survival.

**Scope:** Only apply to `sess_evolution-*`, `sess_creator-*`, and `sess_talome-claude` sessions. User terminal sessions can remain raw PTY (simpler, lower latency).

#### Priority 3: Health check endpoint for daemon

Add a simple health probe so core (or a supervisor) can detect daemon failure:

```typescript
// In terminal-daemon.ts
app.get("/health", (c) => c.json({ status: "ok", bootId: BOOT_ID, sessions: sessions.size }));
```

Core pings this every 30s. If 3 consecutive failures, restart daemon.

#### Priority 4: Proxy WebSocket through core (optional)

Currently, browser connects directly to `ws://hostname:4001`. This bypasses core's auth middleware on subsequent frames. Options:

- **Keep current:** Acceptable for home server (LAN-only)
- **Proxy via core:** Route WebSocket through Hono's WebSocket upgrade → adds auth layer, but increases latency
- **Caddy proxy:** If local domains are enabled, route `terminal.hostname.local` → daemon port

**Recommendation:** Keep current model for v1. Add Caddy proxy rule when local domains are configured.

### 3.4 Resilience Flow After Improvements

```
Core crashes → Daemon stays alive (detached process)
  → PTY sessions continue running
  → Clients may briefly disconnect (if connected via core proxy)
  → Reconnect via daemon's direct WebSocket
  → bootId unchanged → "session preserved"

Daemon crashes → tmux sessions survive (Evolution, Claude Code)
  → Daemon restarts (via supervisor or core)
  → New bootId generated
  → Recovered sessions loaded from SQLite
  → Reconnecting client: scroll buffer replayed
  → tmux sessions: reattach to running processes
  → Raw PTY sessions: new shell, old scroll history

Core + Daemon crash → tmux still running
  → On daemon restart: tmux sessions discovered and reattached
  → SQLite provides session metadata
  → User sees "session restored" + continues where they left off
```

---

## 4. Service Architecture Refactoring

### 4.1 Current Service Boundaries

Everything runs in a single Node.js process (core) with one child process (terminal daemon). The core process is responsible for:

- HTTP API serving (45 route groups)
- AI agent + 100+ tools
- Container health monitoring
- Agent loop (3-tier AI intelligence)
- Media optimization queue management
- HLS/transmux transcoding
- Automation engine
- Messaging bots (Telegram, Discord)
- Local domain management (CoreDNS, Caddy, Avahi)
- Digest/activity scheduling

### 4.2 Proposed Service Decomposition

```
┌─────────────────────────────────────────────────────────────┐
│                    Process Supervisor                        │
│              (PM2 or systemd or Docker)                      │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  ┌─────────────────────────────────────────────────────┐    │
│  │  Core API Service (port 4000)                       │    │
│  │  - Hono HTTP routes                                 │    │
│  │  - AI agent + chat streaming                        │    │
│  │  - Authentication + authorization                   │    │
│  │  - Settings management                              │    │
│  │  - App store + installation orchestration           │    │
│  │  - File serving (including HLS segments)            │    │
│  │  - Notification dispatch                            │    │
│  └─────────────────────────────────────────────────────┘    │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐    │
│  │  Terminal Daemon (port 4001)                         │    │
│  │  - PTY session management                           │    │
│  │  - WebSocket server                                 │    │
│  │  - Session persistence (SQLite)                     │    │
│  │  [EXISTING — make detached]                         │    │
│  └─────────────────────────────────────────────────────┘    │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐    │
│  │  Background Worker (no port)                         │    │
│  │  - Monitor (container health, disk)                 │    │
│  │  - Agent loop (3-tier AI intelligence)              │    │
│  │  - Automation cron                                  │    │
│  │  - Digest + activity schedulers                     │    │
│  │  - Media auto-optimize scanner                      │    │
│  │  [NEW — extract from core]                          │    │
│  └─────────────────────────────────────────────────────┘    │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐    │
│  │  Transcoding Service (port 4002 or IPC)              │    │
│  │  - HLS streaming jobs                               │    │
│  │  - Library optimization queue                       │    │
│  │  - Transmux operations                              │    │
│  │  - FFmpeg process management                        │    │
│  │  [NEW — extract from core + optimizer]              │    │
│  └─────────────────────────────────────────────────────┘    │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐    │
│  │  MCP Server (stdio)                                  │    │
│  │  - Claude Code tool access                          │    │
│  │  [EXISTING — no changes needed]                     │    │
│  └─────────────────────────────────────────────────────┘    │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### 4.3 Tight Couplings to Break

| Coupling | Current Location | Decoupling Strategy |
|----------|------------------|---------------------|
| Monitor → Docker client | `monitor.ts` imports `docker/client.ts` | Shared library or Docker event IPC |
| Monitor → DB | Direct Drizzle queries in monitor | Shared DB module (SQLite supports multi-process with WAL) |
| Agent loop → AI SDK | Imports Vercel AI SDK in agent loop | Keep in worker process (same deps) |
| Optimizer → Radarr/Sonarr | Direct HTTP calls in `optimizer.ts` | Webhook callback to core |
| Optimizer → settings | Reads DB settings for config | Pass config at job submission |
| HLS → route handler | HLS lifecycle mixed with file routes | Extract to transcoding service |
| AI tools → optimizer | Direct function calls | REST proxy to transcoding service |
| Messaging → DB | Direct queries for event context | Shared DB (same SQLite file) |

### 4.4 Shared Resources

SQLite with WAL mode supports concurrent readers from multiple processes. All services can share the same `talome.db` file:

- **Core API:** Read/write (settings, apps, conversations, etc.)
- **Background Worker:** Read/write (events, remediation, metrics)
- **Transcoding Service:** Read/write (optimization_jobs, library_scan_results)
- **Terminal Daemon:** Read/write (terminal_sessions)

**Constraint:** Only one process should write to a given table at a time to avoid WAL contention. This is naturally satisfied since each service owns its tables.

### 4.5 Monorepo Structure After Refactoring

```
apps/
  core/                          # Existing — becomes thinner
    src/
      index.ts                   # HTTP server only
      routes/                    # API routes (proxies for transcoding/terminal)
      ai/                        # Agent + tools
      db/                        # Shared DB module
      docker/                    # Docker client (shared library)
      middleware/                 # Auth, rate limiting
      stores/                    # App store management
      proxy/                     # Reverse proxy
      notifications/             # Notification dispatch

  worker/                        # NEW — background services
    src/
      index.ts                   # Worker entry point
      monitor.ts                 # Container health (extracted)
      agent-loop/                # Intelligence (extracted)
      automation/                # Cron + engine (extracted)
      digest.ts                  # Digest scheduler (extracted)
      activity-summary.ts        # Activity summary (extracted)

  transcoder/                    # NEW — transcoding service
    src/
      index.ts                   # Service entry point
      hls.ts                     # HLS job management
      optimizer.ts               # Library optimization
      transmux.ts                # Transmux operations
      queue.ts                   # Job queue (SQLite-backed)
      probe.ts                   # ffprobe wrapper
      hw-detect.ts               # Hardware acceleration

  terminal/                      # EXISTING — already separate
    src/
      terminal-daemon.ts

  dashboard/                     # EXISTING — no changes

packages/
  types/                         # EXISTING — shared types
  db/                            # NEW — shared DB connection + schema
  docker/                        # NEW — shared Docker client
```

### 4.6 Phase Recommendation

Avoid a big-bang refactor. Decompose incrementally:

| Phase | Scope | Risk | Value |
|-------|-------|------|-------|
| 1 | Detach terminal daemon from core | Very low | Daemon survives core crashes |
| 2 | Extract transcoding service | Medium | Core becomes lighter, transcoding independent |
| 3 | Extract background worker | Medium | Core is purely API, background work isolated |
| 4 | Extract shared packages | Low | Clean dependency graph |

---

## 5. Resource Optimization for Low-End Hardware

### 5.1 Critical Findings

#### High Priority (immediate impact)

| Issue | Location | Current Cost | Fix | Savings |
|-------|----------|-------------|-----|---------|
| Monitor polls Docker + events overlap | `monitor.ts:493` + `docker/client.ts:650` | 60+ Docker API calls/min | Use events primary, poll fallback only | ~90% Docker API reduction |
| Stats stream 2s subprocess | `routes/stats-stream.ts:25` | 30 subprocess spawns/min per client | Cache stats 5s, share across clients | 80% subprocess reduction |
| Missing database indexes | `db/schema.ts` | Full table scans | Add indexes on filtered columns | 10-50% query time |
| Container resolution N+1 | `routes/containers.ts:25-32` | O(n²) per request | Build appId map once | O(n) |

#### Medium Priority (cumulative impact)

| Issue | Location | Current Cost | Fix | Savings |
|-------|----------|-------------|-----|---------|
| No HTTP connection pooling | 40+ tool files using bare `fetch()` | New TCP connection per request | Shared HTTP agent per external service | Connection overhead |
| Conversation token pruning | `routes/conversations.ts:56` | Every 30s | Increase to 5min or lazy eviction | Negligible CPU |
| JSON parse/stringify in hot paths | 319 occurrences across 93 files | CPU cycles per request | No action needed (acceptable) | — |
| `systeminformation` dependency | `package.json` | 5MB, rarely used | Replace with `os` module builtins | 5MB memory |

#### Already Optimized (no changes needed)

- Database connection: singleton pattern with WAL
- Docker socket: single instance, no pooling needed
- File serving: range-aware streaming with `fs.createReadStream`
- HLS concurrency: limited to 5 concurrent jobs
- Agent loop: 3-tier cost optimization with budget zones
- Batch query enrichment in app listing
- Atomic file writes for optimization output

### 5.2 Specific Optimizations

#### 5.2.1 Docker API Polling → Event-Driven

```
Current:
  monitor.ts: setInterval(runChecks, 60000)
    → listContainers() every 60s (Docker API call)
    → getSystemStats() every 60s (subprocess: df -Pk)

  docker/client.ts: subscribeDockerEvents()
    → Also subscribes to Docker event stream
    → BOTH run simultaneously

Proposed:
  Docker event stream → primary trigger for container state changes
  Monitor interval → increased to 300s (5 min) as fallback/catchup
  getSystemStats() → cached 30s (shared across all callers)
```

**Estimated savings:** 55 Docker API calls/min → ~1/min (fallback only)

#### 5.2.2 Stats Stream Optimization

```
Current:
  Each connected client → SSE endpoint → getSystemStats() every 2s
  getSystemStats() → spawns `df -Pk` subprocess

Proposed:
  Single shared stats collector (singleton)
    → Polls every 5s (not per-client)
    → Caches result in-memory
    → Multiple SSE clients read from cache
    → Stale data acceptable (5s window for dashboard metrics)
```

**Estimated savings:** N clients × 30 calls/min → 12 calls/min total

#### 5.2.3 Database Index Additions

```sql
-- Most impactful indexes based on query patterns:
CREATE INDEX idx_app_catalog_app_id ON app_catalog(app_id);
CREATE INDEX idx_app_catalog_store_source ON app_catalog(store_source_id);
CREATE INDEX idx_installed_apps_status ON installed_apps(status);
CREATE INDEX idx_system_events_type_source ON system_events(type, source);
CREATE INDEX idx_conversations_user ON conversations(user_id);
CREATE INDEX idx_optimization_jobs_status ON optimization_jobs(status);
CREATE INDEX idx_library_scan_directory ON library_scan_results(directory);
CREATE INDEX idx_notifications_user_read ON notifications(user_id, read);
CREATE INDEX idx_audit_log_created ON audit_log(created_at);
CREATE INDEX idx_container_events_container ON container_events(container_id);
```

#### 5.2.4 Connection Pooling for External Services

```typescript
// Create shared HTTP agents per external service
// In a new file: utils/http-pool.ts

import { Agent } from "undici";

const agents = new Map<string, Agent>();

export function getAgent(baseUrl: string): Agent {
  const host = new URL(baseUrl).host;
  if (!agents.has(host)) {
    agents.set(host, new Agent({
      keepAliveTimeout: 30_000,
      keepAliveMaxTimeout: 60_000,
      connections: 4,           // max concurrent to same host
      pipelining: 1,
    }));
  }
  return agents.get(host)!;
}

// Usage in arr-tools.ts, jellyfin-tools.ts, etc:
// fetch(url, { dispatcher: getAgent(baseUrl), signal: AbortSignal.timeout(8000) })
```

### 5.3 Resource Projections for Constrained Hardware

**Target:** Raspberry Pi 4 (4GB RAM, 4-core ARM Cortex-A72)

| Resource | Current (estimated) | After Optimization | Notes |
|----------|--------------------|--------------------|-------|
| **Memory (idle)** | ~200-250MB | ~150-180MB | Remove `systeminformation`, reduce caches |
| **Memory (active transcoding)** | +200-500MB per ffmpeg | Same | ffmpeg is external process |
| **CPU (idle)** | ~3-5% | ~1-2% | Reduce polling, event-driven |
| **CPU (1 transcode)** | ~80-100% (1 core) | Same | ffmpeg bound |
| **Disk I/O (idle)** | Low (WAL journal) | Same | Already efficient |
| **Docker API calls/min** | ~60 | ~1-5 | Event-driven primary |
| **Subprocess spawns/min** | ~30+ (stats) | ~12 | Shared stats collector |
| **SQLite queries/min** | ~100+ | ~60 | Indexed, reduced polling |

**Key constraint on Pi 4:** Only 1 concurrent transcode job (max). Set `optimization_max_jobs=1` and `HLS_MAX_JOBS=1`. Total memory stays under 1GB with 1 active transcode.

### 5.4 Lazy Loading Opportunities

| Module | Current Load | Proposed | Savings |
|--------|-------------|----------|---------|
| Discord.js (50MB+) | Eager import | `await import()` only if `discord_bot_token` is set | 50MB+ if unused |
| Telegram bot | Eager import | `await import()` only if `telegram_bot_token` is set | Minor |
| App store sync | Runs at startup | Defer 30s after server listen | Faster cold start |
| Custom tools | Loaded at startup | Already non-blocking (good) | — |
| MCP server | Per-request in route | Already lazy (good) | — |

---

## 6. Best Practices Research

### 6.1 Boris Cherny's Claude Code Workflow Recommendations

Boris Cherny (creator and head of Claude Code at Anthropic) has published extensive guidance on effective AI-assisted development. Key takeaways relevant to Talome's evolution/self-improvement system:

**Parallelization via Git Worktrees:** Run 5+ simultaneous Claude Code sessions using separate git worktrees. Expect 10-20% abandonment rate for parallel sessions — this is normal. Talome's evolution system could leverage this for parallel improvement suggestions.

**Plan Mode as Foundation:** Start every complex task in Plan mode. Go back and forth refining the plan before execution. For Talome's auto-execute evolution: consider having the AI generate and review a plan before applying changes.

**CLAUDE.md as Compounding Knowledge:** "Anytime we see Claude do something incorrectly we add it to the CLAUDE.md, so Claude knows not to do it next time." Talome already follows this pattern well. Ensure the evolution system captures learnings from failed runs back into CLAUDE.md.

**Verification Loops:** "Give Claude a way to verify its work. If Claude has that feedback loop, it will 2-3x the quality of the final result." Talome's typecheck + auto-rollback is exactly this pattern. Consider adding runtime verification (start server, hit health endpoint) for deeper validation.

**Skills/Slash Commands:** Codify any workflow executed more than once daily. Talome already has `/self-improve`, `/create-app`, `/add-domain`. Consider adding: `/batch-migrate`, `/audit-deps`, `/benchmark`.

**PostToolUse Hooks:** Auto-format code after edits (`bun run format || true`). Talome could add this to Claude Code sessions for consistent formatting.

### 6.2 Resilience Patterns

#### Circuit Breaker (for external service calls)

Talome calls 12+ external services (Sonarr, Radarr, Jellyfin, etc.) via HTTP. Each should be wrapped in a circuit breaker:

```typescript
// Recommended: opossum library
import CircuitBreaker from "opossum";

const sonarrBreaker = new CircuitBreaker(sonarrFetch, {
  timeout: 8000,                    // matches current 8s timeout
  errorThresholdPercentage: 50,
  resetTimeout: 30000,              // try again after 30s
  volumeThreshold: 3,               // minimum calls before tripping
});

sonarrBreaker.fallback(() => ({
  success: false,
  error: "Sonarr temporarily unavailable",
}));
```

**Where to apply:** Every `arrFetch()`, `jellyfinFetch()`, `overseerrFetch()`, `piholeAPI()`, etc.

#### Retry with Exponential Backoff

Current pattern: `withRetry()` in `docker/client.ts` (2 retries, 1s delay). Extend to all external calls:

```typescript
// Recommended: p-retry library
import pRetry from "p-retry";

const result = await pRetry(() => fetch(url), {
  retries: 3,
  minTimeout: 1000,
  factor: 2,              // 1s, 2s, 4s
  randomize: true,         // jitter to prevent thundering herd
  onFailedAttempt: (error) => {
    if (error.response?.status === 404) throw error; // don't retry 404s
  },
});
```

#### Graceful Shutdown (improve existing)

Current shutdown in `index.ts` (lines 498-534) is good but could be improved:

```typescript
// Current gaps:
// 1. No readiness probe that fails during shutdown
// 2. No drain period for in-flight requests
// 3. Keep-alive connections not tracked

// Add:
let isShuttingDown = false;

// Health endpoint returns 503 during shutdown
app.get("/api/health", (c) => {
  if (isShuttingDown) return c.json({ status: "draining" }, 503);
  // ... existing health check
});

process.on("SIGTERM", async () => {
  isShuttingDown = true;
  // Wait 5s for load balancer to deregister
  await new Promise((r) => setTimeout(r, 5000));
  // Stop accepting new connections
  server.close();
  // Clean up resources...
});
```

### 6.3 Multi-Process Architecture for Node.js

**Recommended stack for Talome:**

| Component | Technology | Purpose |
|-----------|-----------|---------|
| Process Supervisor | PM2 ecosystem | Manage core, worker, transcoder, daemon |
| Job Queue | BullMQ (if Redis available) or SQLite queue | Transcoding, automation execution |
| IPC | REST (control plane) + shared SQLite (data) | Inter-process communication |
| Worker Isolation | `child_process.fork()` | FFmpeg, Claude Code subprocesses |

**PM2 Ecosystem File:**

```javascript
// ecosystem.config.js
module.exports = {
  apps: [
    {
      name: "talome-core",
      script: "apps/core/dist/index.js",
      exec_mode: "fork",          // single instance (SQLite)
      max_memory_restart: "512M",
      kill_timeout: 10000,
    },
    {
      name: "talome-terminal",
      script: "apps/core/dist/terminal-daemon.js",
      exec_mode: "fork",
      max_memory_restart: "256M",
    },
    {
      name: "talome-worker",
      script: "apps/worker/dist/index.js",
      exec_mode: "fork",
      max_memory_restart: "384M",
    },
    {
      name: "talome-transcoder",
      script: "apps/transcoder/dist/index.js",
      exec_mode: "fork",
      max_memory_restart: "256M",  // ffmpeg runs as child processes
    },
  ],
};
```

**Why not clustering:** SQLite doesn't support multiple writers from forked processes sharing the same connection. PM2 cluster mode would require migrating to PostgreSQL. Single-process-per-role is the right fit.

### 6.4 Terminal/PTY Best Practices

**tmux is the production-preferred approach** for session persistence, validated by Claude Remote's architecture:

- ~50ms startup overhead per session
- ~1ms keystroke latency
- ~3MB memory per session
- <0.1% CPU when idle
- Survives: app crashes, network disconnects, sleep/wake
- Only fails on: machine reboot (tmux is memory-only)

**Talome's implementation already follows most best practices.** The main gap is wrapping long-running sessions (Evolution, Claude Code) in tmux for process persistence across daemon restarts.

---

## 7. Migration Strategy

### Phase 1: Quick Wins (1-2 days, no architecture changes)

1. **Add database indexes** — Create migration with 10 indexes listed in §5.2.3
2. **Fix container resolution N+1** — Build appId map once in `routes/containers.ts`
3. **Cache system stats** — Shared singleton with 5s TTL in `routes/stats-stream.ts`
4. **Increase conversation pruner interval** — 30s → 5min in `routes/conversations.ts`
5. **Lazy-load Discord.js** — Dynamic `import()` only when token is configured

**Risk:** Very low. All changes are localized.

### Phase 2: Event-Driven Monitor (2-3 days)

1. **Refactor monitor to be event-driven** — Use Docker event stream as primary trigger
2. **Reduce polling interval** — 60s → 300s (fallback only)
3. **Add Docker container list cache** — 10s TTL shared across routes
4. **Add health check readiness flag** — `isShuttingDown` for graceful shutdown

**Risk:** Low. Monitor behavior changes, but fallback polling ensures no gaps.

### Phase 3: Detach Terminal Daemon (1 day)

1. **Spawn daemon as detached process** — `detached: true, .unref()`
2. **Add health check endpoint** — `/health` on daemon
3. **Add daemon restart logic** — Core pings health, restarts if 3 failures
4. **Wrap Evolution/Claude sessions in tmux** — Process persistence across restarts

**Risk:** Low. Daemon already works independently; this just ensures it survives core crashes.

### Phase 4: Extract Transcoding Service (1-2 weeks)

1. **Create `apps/transcoder/` package** — New monorepo workspace
2. **Move `media/optimizer.ts`** — Extract core logic, keep AI tool proxies in core
3. **Move HLS/transmux from `routes/files.ts`** — Extract job management
4. **Create REST API** — Job submission, status, progress SSE
5. **Implement completion webhook** — Transcoder → Core for Radarr/Sonarr rescan
6. **Update AI tools** — Proxy to transcoding service instead of direct function calls
7. **Update `index.ts`** — Spawn transcoder as separate process
8. **Keep HLS segment serving in core** — Static file server for `/hls/<hash>/*`

**Risk:** Medium. Multiple integration points to update. Feature-flag the new architecture for rollback.

### Phase 5: Extract Background Worker (1 week)

1. **Create `apps/worker/` package** — New monorepo workspace
2. **Move `monitor.ts`** — Container health monitoring
3. **Move `agent-loop/`** — 3-tier AI intelligence
4. **Move `automation/`** — Cron + engine
5. **Move schedulers** — Digest, activity summary
6. **Shared DB access** — Same SQLite file with WAL
7. **Event coordination** — Worker writes events to DB, core reads on demand

**Risk:** Medium. Agent loop and automation engine have complex dependencies.

### Phase 6: Shared Packages (3-5 days)

1. **Extract `packages/db/`** — Shared schema, connection, migrations
2. **Extract `packages/docker/`** — Shared Docker client
3. **Update all services** — Import from shared packages
4. **Clean up dependency graph** — Each service declares explicit deps

**Risk:** Low. Mostly refactoring imports.

### Integration Points with apps/dashboard/

| Frontend Component | Current Backend | After Refactoring |
|-------------------|----------------|-------------------|
| Dashboard widgets | Core API `/api/stats/*` | Core API (unchanged) |
| Chat UI | Core API `/api/chat` | Core API (unchanged) |
| Terminal page | Daemon WS `ws://host:4001` | Daemon WS (unchanged) |
| Media optimizer page | Core API `/api/optimization/*` | Core API → proxies to transcoder |
| HLS video player | Core API `/hls-start`, `/hls/*` | Core API → proxies to transcoder for jobs, serves segments directly |
| App store | Core API `/api/apps/*` | Core API (unchanged) |
| Automations | Core API `/api/automations/*` | Core API → proxies to worker for execution |

**Frontend changes needed:** None for Phases 1-3. Minimal for Phase 4 (optimization progress SSE endpoint may change). None for Phases 5-6.

---

## Appendix A: File Impact Matrix

| File | Phase 1 | Phase 2 | Phase 3 | Phase 4 | Phase 5 |
|------|---------|---------|---------|---------|---------|
| `db/schema.ts` | Add indexes | — | — | — | Move to `packages/db/` |
| `routes/containers.ts` | Fix N+1 | — | — | — | — |
| `routes/stats-stream.ts` | Cache stats | — | — | — | — |
| `routes/conversations.ts` | Increase interval | — | — | — | — |
| `monitor.ts` | — | Event-driven | — | — | Move to `apps/worker/` |
| `docker/client.ts` | — | Container cache | — | — | Move to `packages/docker/` |
| `index.ts` | Lazy Discord | Shutdown flag | Detach daemon | Spawn transcoder | Remove worker code |
| `terminal-daemon.ts` | — | — | Health endpoint | — | — |
| `media/optimizer.ts` | — | — | — | Move to `apps/transcoder/` | — |
| `routes/files.ts` | — | — | — | Extract HLS/transmux | — |
| `ai/tools/optimization-tools.ts` | — | — | — | Proxy to transcoder | — |
| `agent-loop/*` | — | — | — | — | Move to `apps/worker/` |
| `automation/*` | — | — | — | — | Move to `apps/worker/` |

## Appendix B: Dependency Analysis for Splitting

### Core API (after extraction)

```
dependencies:
  @hono/node-server
  @ai-sdk/anthropic
  ai (vercel)
  zod
  drizzle-orm
  better-sqlite3
  dockerode          # still needed for install/start/stop
  @hugeicons/*       # icon types for MCP responses

devDependencies:
  typescript
  tsx
```

### Background Worker

```
dependencies:
  drizzle-orm
  better-sqlite3
  dockerode
  @ai-sdk/anthropic  # agent loop triage/remediation
  ai (vercel)
  zod
  node-cron
```

### Transcoding Service

```
dependencies:
  @hono/node-server   # REST API for job management
  drizzle-orm
  better-sqlite3
  zod

# No AI SDK needed
# No Docker SDK needed
# ffmpeg/ffprobe are system binaries
```

### Terminal Daemon

```
dependencies:
  @hono/node-server   # HTTP endpoints
  node-pty
  better-sqlite3
  zod
```
