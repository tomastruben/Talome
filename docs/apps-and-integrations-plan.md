# Files, integrations and app polish — plan

Date: 30 September 2026. Companion to the umbrelOS 2.0 assessment. Umbrel is licensed PolyForm Noncommercial, so everything here is designed and written independently for Talome (AGPL): we match or beat the outcome, never copy the code.

## What already shipped on this branch

- **Uploads that work for real files.** Every `/api/*` request over 5 MB was rejected, so any upload larger than 5 MB failed. Uploads now stream straight to disk (`PUT /api/files/upload-stream`), one request per file, with no size cap beyond free space (checked up front, 507 when full).
- **Upload UX.** Per-file progress, cancel, retry, three uploads at a time, "keep both" on name clashes (`photo (1).jpg`), folder upload (picker and drag-and-drop, structure kept), a warning before leaving the page mid-upload.
- **No half-written files.** Bodies go to a hidden `.part` file and are renamed into place only when complete; short bodies are rejected; symlink escapes and dotfile paths are refused.
- **Sign-in polish.** The desktop wallpaper (or a bundled default) behind a frosted card, lock-screen clock, and a two-step first-run indicator.

## Where Files stands

Umbrel column is from the 2.0.0 release notes and `packages/umbreld/source/modules/files` at tag 2.0.0.

| Capability | Talome today | Umbrel 2.0 | Target |
|---|---|---|---|
| Upload | Streaming, progress, folders (this branch) | "Safer uploads" | Resumable uploads for multi-GB files over flaky links |
| Delete | **Permanent**, no undo | Trash with restore | Trash with restore and retention |
| Copy | Missing | Yes | Copy, duplicate |
| Search | Missing | Background index, instant search | SQLite FTS index + watcher; the assistant can search it |
| Thumbnails | Quick Look only | Continuous, HEIC | Grid view with thumbnails, HEIC and video posters |
| Favorites / recents | Missing | Yes | Sidebar favorites and recents |
| Archives | Missing | Yes | Download a folder or selection as zip; extract zip |
| Sharing | Missing | Member shares, Samba | Per-member private folders, SMB shares, expiring share links |
| Cloud | rclone wrapper used only by backups | Dropbox, OneDrive, iCloud Drive, Nextcloud, WebDAV; Google Drive "coming soon" | Same set **plus Google Drive**, as verified, resumable imports and syncs |
| Desktop OS integration | None | Mac companion mounts it in Finder | SMB + Bonjour first; a companion app only if demand proves it |
| Photos / phone backup | Via installable apps (Immich) | Native Photos app, iOS background backup | Keep Immich as the photo app; make its setup one verified step |

## Phases

Each phase ships on its own and has a gate that must pass before it is called done.

### F1 — Files you can trust (next)

1. **Trash.** Deletes move to `.talome-trash/` on the same volume (a rename, so it is instant and costs no space), with original path and time in a small index. Restore, empty, and automatic purge after 30 days. The assistant's `delete_file` tool moves to trash too; purging stays a destructive, approval-gated action.
2. **Copy and duplicate**, streaming, with the same keep-both naming as uploads.
3. **Zip download** of folders and selections (streamed, no temp file) and **extract** for `.zip`.
4. **Grid view with thumbnails.** Generate thumbnails in a worker on first view and cache them by content hash; HEIC via `sharp`/libheif, video posters via the existing ffmpeg.
5. **Inline "New folder"** that asks for a name instead of creating "New Folder".
6. **Split `files/page.tsx`** (1,600 lines) into list, grid, toolbar, preview and selection components so the rest of this plan is buildable.

Gate: deleting and restoring 1,000 files returns every file byte-identical; a 10 GB upload survives a tab reload with resumable uploads (below); lint clean on the new components.

**Resumable uploads.** Add a small tus-style protocol on top of the streaming endpoint: create an upload id, `PATCH` chunks with offsets into the `.part` file, `HEAD` for the current offset. The client resumes after a dropped connection or reload. Only needed for very large files, so it follows the basics.

### F2 — Find anything

1. **Index** file names, sizes, types and timestamps in SQLite FTS5, kept current by a filesystem watcher plus a nightly reconcile scan; only enabled drives are indexed.
2. **Instant search** in Files and the command palette (⌘K), with filters (type, date, size, drive).
3. **Assistant access.** A `search_files` tool, scoped by the MCP token scope work already merged. Extend scopes with **folder grants** (the equivalent of Umbrel's per-folder access, but per token): a token can read or write only the folders it was given.
4. **Favorites and recents** in the Files sidebar.

Gate: search over 500k files returns in under 150 ms; a token without a folder grant cannot list, read or search inside it.

### F3 — Share and reach files from other devices

1. **Member private folders.** Each member gets a home folder only they (and admins) can see; enforced in `isAllowed`, not just hidden in the UI.
2. **SMB shares** from a Samba container managed by Talome: pick a folder, choose who can read/write, advertise it over Bonjour so it appears in Finder and Windows Explorer. This covers most of what Umbrel's Mac companion does, with no app to install.
3. **Share links.** Expiring, optionally password-protected, read-only links to a file or folder, revocable, with access logged in the audit trail.

Gate: a member cannot reach another member's folder through Files, SMB, share links, the assistant or MCP.

### F4 — Cloud connections (iCloud, Google Drive, Dropbox, OneDrive, WebDAV)

Built on rclone (already wrapped in `apps/core/src/backup/rclone.ts`) and on the durable runs from P1, so an import can survive a restart, report progress and resume.

1. **Connections page** (Settings → Connections → Cloud): add a provider, authorize, test. Credentials are stored as encrypted settings and passed to rclone through its config, never through model context.
   - **Google Drive** and **Google Docs**: OAuth. Docs, Sheets and Slides export as `.docx`, `.xlsx`, `.pptx` (or PDF) on import. Self-hosters need an OAuth client of their own or rclone's default; the flow must explain this in one screen. This is the one Umbrel has not shipped.
   - **iCloud Drive**: rclone's iCloud Drive backend. It needs Apple ID sign-in with two-factor trust, and does not work with Advanced Data Protection enabled; the UI must say so before the person starts. Spike this first — it is the most fragile provider.
   - **Dropbox, OneDrive**: OAuth through rclone.
   - **Nextcloud, ownCloud, any WebDAV**: URL and app password.
2. **Import** (one-time copy into a chosen folder) and **Sync** (scheduled, one-way or two-way) run as durable automation runs: each batch is a recorded step, interrupted runs resume without re-copying, and the run ends with a verification step (file counts and checksums where the provider exposes them).
3. **The assistant can drive it** ("import my Google Drive Photos folder into Photos"), with the import itself approval-gated like other writes.

Gate: a 50 GB import killed at random points completes with identical file counts and checksums and no duplicates; no provider credential appears in the audit log, notifications or model context (canary test, as in the P0 gates).

### F5 — Slack and other places people already talk

Talome already supports Telegram and Discord as chat channels and has webhook, ntfy, email and web push notifications.

1. **Slack as a chat channel** (Socket Mode, so no public URL is needed): talk to the assistant in a DM or a channel, same as Telegram today, using the `messaging` actor so the gateway's policy applies.
2. **Approvals in Slack.** Pending approvals post as a message with Approve and Deny buttons, bound to the Slack user and verified by Slack's request signature. This is the "send approval requests to my phone" follow-up from P0, and it works for Telegram and Discord too, via inline buttons.
3. **Slack as a notification channel** alongside the existing ones, with per-channel severity filters.
4. **File drops.** Files sent to the bot in Slack, Telegram or Discord can be saved to a chosen folder ("save to Files/Inbox").

Gate: an approval clicked in Slack runs the waiting call exactly once and is attributed to that Slack user in the audit log; a click from a user who isn't the linked admin is rejected.

### F6 — Design polish across the internal apps

Apply the design principles in `CLAUDE.md` consistently, one app at a time, starting with the most used:

1. **Files**: grid/list toggle, breadcrumbs with drag-to-move, keyboard shortcuts (⌘A, ⌘⌫ to trash, Space for Quick Look, ⌘C/⌘V), empty states that offer "Upload" and "Connect a cloud".
2. **First run after sign-in**: one screen that asks what the person wants first — "Set up my media stack", "Store and share files", "Back up my computer" — and runs that as a verified setup (P2 intents), instead of dropping them on an empty dashboard.
3. **Motion and type audit**: several components use 300–400 ms animations and ad-hoc text sizes; bring them within the 200 ms and four-size rules.
4. **Shared wallpaper**: move the wallpaper choice from browser storage to a per-user server setting, so the desktop and sign-in look the same on every device (the sign-in screen currently uses the choice from the same browser, or the default).

Gate: each app passes a checklist review (spacing, type scale, motion, empty/error/loading states, keyboard access, 390 px width) with screenshots in the PR.

## Order and rationale

F1 first: permanent delete is a data-loss risk, and grid/thumbnails/copy are table stakes. F2 next, because search is what makes a home server feel fast and it unlocks folder-scoped agent access. F4 before F3 if people mostly want to leave iCloud or Google; F3 before F4 if they mostly want Finder access at home — decide with usage data. F5 is independent and can run in parallel once F1 lands. F6 threads through all of them.

## Not planned

A native Photos app or phone backup app. Immich already does this well and installs from the store; the better investment is making its setup and backup verification one step (see the assessment's P2 intents).
