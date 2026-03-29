# ADR-005: Legal Disclaimers & Audible Integration

## Status
Proposed

## Context
Talome integrates with torrent clients (qBittorrent), indexers (Prowlarr), and media managers (Sonarr/Radarr/Readarr) — tools that can be used for both legitimate and infringing purposes. Adding Audible audiobook support introduces a second legal dimension: DRM circumvention under DMCA §1201 and EU Copyright Directive Article 6.

Currently, Talome has **zero legal disclaimers** anywhere in the codebase. This leaves the project unnecessarily exposed.

## Decision

### Part 1: Legal Protection Framework

Add a consistent disclaimer framework across Talome that makes clear: **Talome is a tool; the user is responsible for how they use it.**

#### 1A. Global Legal Notice (Settings → About)

Add a "Legal" section to Settings with this text:

> **User Responsibility**
>
> Talome is a self-hosted server management platform. It provides tools for organizing, managing, and accessing media and applications that you own or have legal rights to use.
>
> Talome does not host, distribute, or provide access to copyrighted content. Features that interact with download clients, indexers, or third-party services are provided as neutral tools. You are solely responsible for ensuring that your use of Talome and any connected services complies with all applicable laws in your jurisdiction, including but not limited to copyright law, digital rights management regulations, and terms of service of third-party platforms.
>
> The Talome project and its contributors assume no liability for how you use this software.

#### 1B. First-Use Disclaimer (shown once, stored in settings)

When a user first configures any download-capable service (qBittorrent, Prowlarr, or Audible import tools), show a one-time acknowledgment dialog:

> **Before you continue**
>
> You are connecting Talome to services that can download or import content. You are responsible for ensuring that all content you download, import, or access through Talome is legally obtained and that your use complies with the laws of your jurisdiction.
>
> By continuing, you acknowledge this responsibility.
>
> [I Understand]

Store `disclaimer_acknowledged: true` in settings so it only appears once.

#### 1C. Contextual Warnings (inline, non-blocking)

Small muted text shown in specific contexts:

- **Audiobooks → Search tab** (Prowlarr results): "Results from your configured indexers. You are responsible for the legality of downloads in your jurisdiction."
- **Audiobooks → Audible Import tab**: "Importing from Audible may involve DRM conversion using tools you have installed. You are responsible for compliance with applicable laws."
- **Media → Downloads**: "Content downloaded via connected services is your responsibility."

These are informational — they don't block the user or require acknowledgment.

#### 1D. LICENSE / DISCLAIMER file in repo root

Standard open-source disclaimer alongside the project license:

> THIS SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND. THE AUTHORS AND CONTRIBUTORS ARE NOT RESPONSIBLE FOR HOW THIS SOFTWARE IS USED. USERS ARE SOLELY RESPONSIBLE FOR ENSURING THEIR USE COMPLIES WITH ALL APPLICABLE LAWS IN THEIR JURISDICTION.

---

### Part 2: Audible Integration Architecture

#### Design Principles

1. **Talome never ships DRM circumvention code** — follows the Calibre model
2. **User installs their own tools** — Talome detects and orchestrates, doesn't bundle
3. **Explicit user action** — every import is user-initiated, never automatic
4. **Clear separation** — metadata access (safe) vs. content import (user's responsibility)

#### Architecture: Three Layers

```
┌─────────────────────────────────────────────────────┐
│ Layer 1: Metadata (always available)                │
│ ─────────────────────────────────────               │
│ • Audible account connection (Amazon OAuth)         │
│ • Library browser (titles, covers, metadata)        │
│ • Sync status: Audible ↔ Audiobookshelf comparison  │
│ • Wishlist browsing                                 │
│ • No DRM involvement whatsoever                     │
│ • Settings: audible_auth_file (encrypted)           │
└─────────────────────────────────────────────────────┘
                        │
                        ▼
┌─────────────────────────────────────────────────────┐
│ Layer 2: Import Pipeline (if user tools detected)   │
│ ─────────────────────────────────────               │
│ • Detects user-installed audible-cli + ffmpeg       │
│ • User clicks "Import" on specific book             │
│ • Talome orchestrates: download → convert → move     │
│ • Target: Audiobookshelf watched folder             │
│ • Triggers Audiobookshelf library scan              │
│ • Talome's code: HTTP calls + file move only         │
│ • DRM handling: entirely in user's tools            │
└─────────────────────────────────────────────────────┘
                        │
                        ▼
┌─────────────────────────────────────────────────────┐
│ Layer 3: Playback (via Audiobookshelf)              │
│ ─────────────────────────────────────               │
│ • Imported books appear in Audiobookshelf           │
│ • Existing Talome audiobook player handles playback  │
│ • Progress sync, chapters, etc. — all existing UX   │
└─────────────────────────────────────────────────────┘
```

#### Authentication Flow

Audible uses Amazon's internal OAuth (reverse-engineered, not the public "Login with Amazon" API). The public LWA API only gives profile data — it does NOT grant Audible API access. We must use the same flow as the official Audible iOS app.

**Primary approach — Popup with local callback:**

1. User clicks "Connect with Amazon" in Settings → Connections
2. Talome shows a marketplace selector (US, UK, DE, FR, etc.)
3. Backend generates an OAuth URL with Audible-specific parameters:
   - `openid.oa2.response_type=code`
   - `openid.oa2.code_challenge` (S256 PKCE)
   - `openid.assoc_handle=amzn_audible_ios_{country_code}`
   - `openid.return_to` → **Talome's own callback URL** (e.g., `http://host:port/api/audible/callback`)
   - Backend stores `code_verifier` + `serial` in a short-lived session
4. Frontend opens popup via `window.open(oauthUrl, 'audible-login', 'width=500,height=650')`
5. User authenticates directly on Amazon's login page (CAPTCHA, 2FA, MFA handled natively)
6. Amazon redirects popup to Talome's callback endpoint with `authorization_code` in query params
7. Backend extracts the code, calls Audible's `/auth/register` with `authorization_code` + `code_verifier` + `serial`
8. Receives: `access_token`, `refresh_token`, `adp_token`, RSA `device_private_key`, cookies
9. Tokens stored encrypted as setting: `audible_auth_file`
10. Callback page renders "Connected — you can close this window"
11. Frontend detects completion via polling `GET /api/audible/auth-status` → updates UI

**User experience:** Click → login in popup → done. No copy-paste needed.

**Fallback — Copy-paste flow** (if Amazon rejects custom `return_to`):

If Amazon strictly validates the `return_to` and requires it to be `maplanding`, fall back to the established pattern used by audible-cli, Libation, and OpenAudible:

1. Backend generates OAuth URL with `return_to=https://www.amazon.{domain}/ap/maplanding`
2. Frontend opens new tab to Amazon login
3. User authenticates, Amazon redirects to maplanding (404 page)
4. User copies the full URL from their browser's address bar
5. Pastes URL into a text field in Talome's Settings
6. Backend extracts `authorization_code` from the URL and completes registration

The popup approach should be tested first — the `return_to` parameter is part of the URL we construct, and since this is an undocumented internal API (not the official LWA), Amazon may not strictly validate it.

**Key technical details:**
- Amazon blocks iframes (`X-Frame-Options: DENY`) — popup is required, not iframe
- The `client_id` is constructed from a device `serial` + Audible device type identifier
- All subsequent API requests are signed using the RSA private key from device registration
- Tokens refresh automatically; `refresh_token` has long expiry

#### Tool Detection

New backend endpoint: `GET /api/audiobooks/audible/status`

```json
{
  "authenticated": true,          // Audible auth file exists and valid
  "marketplace": "us",            // Connected marketplace
  "importAvailable": true,        // audible-cli + ffmpeg detected
  "audibleCli": {
    "installed": true,
    "version": "0.3.1",
    "path": "/usr/local/bin/audible"
  },
  "ffmpeg": {
    "installed": true,
    "version": "6.1",
    "aaxcSupport": true           // version >= 4.4
  },
  "targetLibrary": "Audioknihy"   // Audiobookshelf library for imports
}
```

If tools aren't detected, the Audible tab shows metadata-only mode with a hint: "Install audible-cli and ffmpeg to enable importing."

#### Import Pipeline (backend)

When user clicks "Import" on a book:

1. `POST /api/audiobooks/audible/import` with `{ asin: "B08..." }`
2. Backend executes (via user's audible-cli): `audible download --asin B08... --aaxc`
3. Backend executes (via user's ffmpeg): `ffmpeg -audible_key X -audible_iv Y -i book.aaxc -c copy book.m4b`
4. Moves resulting `.m4b` to Audiobookshelf watched folder: `{abs_library_path}/{Author}/{Title}/`
5. Triggers Audiobookshelf library scan via API
6. Returns status to frontend

**Talome's code only**: makes HTTP calls to audible-cli's outputs and moves files. The actual DRM decryption happens in FFmpeg (user's binary), using keys from audible-cli (user's tool). Talome never contains decryption logic.

#### Import Status Tracking

Track active imports in SQLite:

```sql
CREATE TABLE audible_imports (
  id TEXT PRIMARY KEY,
  asin TEXT NOT NULL,
  title TEXT NOT NULL,
  author TEXT,
  status TEXT NOT NULL DEFAULT 'pending',  -- pending | downloading | converting | moving | complete | failed
  progress REAL DEFAULT 0,
  error TEXT,
  started_at INTEGER NOT NULL,
  completed_at INTEGER
);
```

Frontend polls `GET /api/audiobooks/audible/imports` every 5 seconds (matches existing download polling pattern).

---

### Part 3: UI/UX Design

#### Audiobooks Page — New Tab: "Audible"

Add a fourth tab to the existing three (Library / Search / Downloads):

```
[Library] [Search] [Downloads] [Audible]
```

**Tab visible only when** `audible_auth_file` setting exists (user has connected their account).

#### Audible Tab — Layout

```
┌──────────────────────────────────────────────────────────┐
│ [Filter: All ▾] [Sort: Recently Added ▾]  🔍 Search...  │
│                                                          │
│ ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐ │
│ │ cover  │ │ cover  │ │ cover  │ │ cover  │ │ cover  │ │
│ │        │ │        │ │        │ │        │ │        │ │
│ │        │ │        │ │ LOCAL  │ │        │ │IMPORT- │ │
│ └────────┘ └────────┘ └────────┘ └────────┘ └─ING───┘ │
│  Title      Title      Title      Title      Title      │
│  Author     Author     Author     Author     Author     │
│  ⏱ 8h 30m   ⏱ 12h     ⏱ 6h 15m   ⏱ 9h      ⏱ 11h    │
│  [Import]   [Import]   ✓ Local    [Import]   ░░░ 34%   │
│                                                          │
│ ────────────────────────────────────────────────────────  │
│ ⚖ Importing from Audible may involve DRM conversion      │
│   using tools you have installed. You are responsible     │
│   for compliance with applicable laws.                    │
└──────────────────────────────────────────────────────────┘
```

**Filter options**: All / Audible Only / Local / Importing

**Status badges on covers:**
- No badge — available on Audible, not yet imported
- `LOCAL` (emerald) — already exists in Audiobookshelf
- `IMPORTING` (amber) — import in progress with percentage
- `FAILED` (red) — import failed (click for details)

**Actions per book:**
- `[Import]` button — starts import pipeline (single book)
- Click cover/title → Audible detail view (metadata, description, narrator, chapters)
- If LOCAL: click navigates to Audiobookshelf detail page instead

#### Audible Tab — Empty/Config States

**No Audible account connected:**
```
┌──────────────────────────────────────┐
│     📚                               │
│     Connect your Audible account     │
│     to see your library here         │
│                                      │
│     [Go to Settings]                 │
└──────────────────────────────────────┘
```

**Account connected but no import tools:**
```
(Library grid shown in metadata-only mode — no Import buttons)

┌──────────────────────────────────────────────────┐
│ ℹ Import tools not detected. Install audible-cli │
│   and ffmpeg to enable importing audiobooks.     │
└──────────────────────────────────────────────────┘
```

#### Bulk Import

Top-right action when import tools are available:

```
[Import All Missing (23)]
```

Opens confirmation dialog:
```
┌──────────────────────────────────────────────────┐
│  Import 23 audiobooks from Audible?              │
│                                                  │
│  This will download and convert 23 books from    │
│  your Audible library to your Audiobookshelf     │
│  library "Audioknihy".                           │
│                                                  │
│  Estimated size: ~12 GB                          │
│  Estimated time: varies by connection            │
│                                                  │
│  ⚖ You are responsible for ensuring this          │
│    complies with applicable laws.                │
│                                                  │
│           [Cancel]  [Import All]                 │
└──────────────────────────────────────────────────┘
```

#### Settings → Connections: Audible Entry

```typescript
audible: {
  label: "Audible",
  hint: "Amazon Audible library sync & import",
  custom: true,  // Not a simple URL+key pattern
}
```

Custom section in connections settings — **not connected state:**
```
┌──────────────────────────────────────────────────┐
│ Audible                                          │
│ Amazon Audible library sync & import             │
│                                                  │
│ Marketplace    [United States ▾]                  │
│                                                  │
│ [Connect with Amazon ↗]                          │
│                                                  │
│ A popup will open for you to sign in             │
│ with your Amazon account.                        │
└──────────────────────────────────────────────────┘
```

**Connected state:**
```
┌──────────────────────────────────────────────────┐
│ Audible                                          │
│ Amazon Audible library sync & import             │
│                                                  │
│ Status         ● Connected as tom@example.com    │
│ Marketplace    United States                     │
│                Last synced: 2 hours ago           │
│                                                  │
│ Import tools   ● audible-cli 0.3.1               │
│                ● ffmpeg 6.1 (AAXC ✓)             │
│                                                  │
│ Target library [Audioknihy ▾]                     │
│ Import format  [M4B (lossless) ▾]                 │
│                                                  │
│ [Disconnect]            [Sync Library Now]        │
│                                                  │
│ ⚖ Content import uses tools installed on your     │
│   system. You are responsible for compliance      │
│   with applicable laws in your jurisdiction.      │
└──────────────────────────────────────────────────┘
```

**Fallback state** (if popup approach fails, shown instead of the button):
```
┌──────────────────────────────────────────────────┐
│ Audible                                          │
│ Amazon Audible library sync & import             │
│                                                  │
│ Marketplace    [United States ▾]                  │
│                                                  │
│ Step 1: [Open Amazon Login ↗]                    │
│ Step 2: Sign in with your Amazon account         │
│ Step 3: Copy the URL after login and paste below │
│                                                  │
│ [Paste the redirect URL here...              ]   │
│                                                  │
│         [Connect]                                │
└──────────────────────────────────────────────────┘
```

---

### Part 4: New Backend Domain

#### Domain Registration

```typescript
registerDomain({
  name: "audible",
  settingsKeys: ["audible_auth_file"],
  tools: {
    audible_get_status:    audibleGetStatusTool,
    audible_list_library:  audibleListLibraryTool,
    audible_get_book:      audibleGetBookTool,
    audible_sync_library:  audibleSyncLibraryTool,
    audible_import_book:   audibleImportBookTool,
    audible_import_status: audibleImportStatusTool,
  },
});
```

#### New API Routes

```
# Authentication
POST /api/audible/auth/start          — Generate OAuth URL + store session (code_verifier, serial)
GET  /api/audible/callback            — Receive OAuth redirect from Amazon popup
POST /api/audible/auth/complete       — Fallback: accept pasted maplanding URL
GET  /api/audible/auth-status         — Poll for auth completion (frontend uses this)
POST /api/audible/disconnect          — Remove auth tokens

# Library
GET  /api/audible/library             — List user's Audible library (metadata)
GET  /api/audible/book/:asin          — Book detail (metadata, chapters, cover)
GET  /api/audible/sync-status         — Compare Audible library vs Audiobookshelf
POST /api/audible/sync                — Refresh library metadata from Audible

# Import
GET  /api/audible/status              — Auth + tool detection status
POST /api/audible/import              — Start import for a single book { asin }
POST /api/audible/import/bulk         — Start bulk import { asins[] }
GET  /api/audible/imports             — List active/recent imports with progress
DELETE /api/audible/import/:id        — Cancel an in-progress import
```

#### New Files

```
apps/core/src/ai/tools/audible-tools.ts     — Tool definitions
apps/core/src/routes/audible.ts              — API routes (auth, library, import)
apps/core/src/utils/audible-auth.ts          — OAuth URL generation, token management
apps/core/src/utils/audible-api.ts           — Audible API client (library, metadata)
apps/core/src/utils/audible-import.ts        — Import pipeline (download → convert → move)
apps/core/src/db/schema.ts                   — audible_imports table addition
```

---

### Part 5: Implementation Phases

**Phase 1 — Legal Framework** (do first, protects existing features too)
- Add disclaimer to Settings → About
- Add first-use acknowledgment dialog for download services
- Add contextual disclaimers to Search tab, Downloads
- Add LICENSE disclaimer to repo

**Phase 2 — Audible Metadata** (safe, no DRM)
- Audible authentication flow in Settings
- Library sync + metadata storage
- Audible tab with library grid (metadata-only)
- Sync status badges (Local vs Audible-only)

**Phase 3 — Import Pipeline** (user tools required)
- Tool detection (audible-cli, ffmpeg)
- Single-book import flow
- Import status tracking + polling UI
- Audiobookshelf folder placement + scan trigger

**Phase 4 — Bulk Operations**
- Bulk import with progress tracking
- Auto-sync scheduling (check for new purchases)
- Import queue management

## Key Files

- `apps/dashboard/src/app/dashboard/audiobooks/page.tsx` — Add Audible tab
- `apps/dashboard/src/components/settings/sections/connections.tsx` — Add Audible connection
- `apps/dashboard/src/components/ui/legal-disclaimer.tsx` — Reusable disclaimer component
- `apps/core/src/ai/tools/audible-tools.ts` — New tool domain
- `apps/core/src/routes/audible.ts` — API routes
- `apps/core/src/routes/audiobooks.ts` — Add disclaimer endpoint

## Consequences

- Talome is legally protected via clear user-responsibility language across all download features
- Audible integration follows the Calibre model: orchestrate user's tools, never bundle DRM code
- Metadata-only mode provides value even without import tools
- The same disclaimer framework protects existing torrent/Prowlarr integration retroactively
- Phase 1 (legal framework) should ship independently — it protects us regardless of Audible work
