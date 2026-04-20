# Changelog

All notable changes to Talome are documented here.
This project follows [Semantic Versioning](https://semver.org/) and the [Keep a Changelog](https://keepachangelog.com/) format.

The full, detailed changelog (feature-by-feature) lives in the documentation:
**[talome.dev/docs/changelog](https://talome.dev/docs/changelog)** — or in [`apps/web/content/docs/changelog.mdx`](apps/web/content/docs/changelog.mdx) if you're browsing the source.

This file is a short, high-signal summary of security-relevant and user-visible changes.

---

## Unreleased

### Security

- **Terminal daemon hardening.** The PTY daemon on port 4001 now binds to
  `127.0.0.1` by default (was `0.0.0.0`), uses bcrypt with a constant-time
  comparison for passwords (was unsalted SHA-256 with non-constant-time
  compare), requires an 8-character minimum password (was 4), rate-limits
  WebSocket auth attempts, and locks CORS to loopback origins. Legacy
  SHA-256 hashes are detected on first login and force a password reset.
- **CSRF protection.** Added Hono's CSRF middleware with Origin and
  Sec-Fetch-Site validation on every state-changing route. Webhook
  endpoints (HMAC-validated) are exempt.
- **Tighter CORS allowlist.** Production now trusts only loopback,
  RFC1918 private ranges, Tailscale's 100.64.0.0/10, link-local IPv6,
  `*.local` mDNS hosts, and origins explicitly listed in
  `DASHBOARD_ORIGIN`. Public hostnames must be opted in — arbitrary
  `*:3000` origins are no longer accepted.
- **Session cookies.** `secure` flag now reflects the actual request
  scheme (HTTPS detected via `X-Forwarded-Proto`) instead of hard-coded
  `false`. HTTP LAN deployments still work; HTTPS deployments get the
  flag set.
- **Custom AI tools disabled by default.** `create_tool`, `reload_tools`,
  and `list_custom_tools` now require `TALOME_ENABLE_CUSTOM_TOOLS=true`
  to run. They execute arbitrary TypeScript in-process with no sandbox,
  and the previous regex denylist was not a security boundary.

### Added

- **Automatic SQLite self-backup.** Daily `VACUUM INTO` snapshots of
  `talome.db` written to `~/.talome/backups/` (native) or the
  `talome-backups` Docker volume (Compose). Configurable via
  `TALOME_SELF_BACKUP_INTERVAL_MS` and `TALOME_SELF_BACKUP_KEEP`.
  Manual snapshots via `POST /api/backups/self`. Listing via
  `GET /api/backups/self`.
- **Docker Compose template retained for dev/CI only.** Running Talome
  itself in a container breaks self-evolution (no writable source tree,
  no `.git`), so the Compose path is no longer offered as a supported
  install method. The template still exists at the repo root with a
  header banner explaining this, and is used by CI for smoke tests.
  `.dockerignore` added to keep `.env`, local databases, and dev
  artifacts out of any image built from this tree.

### Fixed

- **Installation docs.** `apps/web/content/docs/getting-started/installation.mdx`
  previously described a Docker-only install that didn't match the actual
  `install.sh` (which does a native launchd/systemd install). Docs now
  describe the native install as the only supported path, with a clear
  note explaining why Docker-in-a-container is incompatible with
  self-evolution.
- **Windows installer.** `install.ps1` previously attempted a Docker-based
  install that broke self-evolution. Replaced with a message pointing
  Windows users at WSL2 until a native Windows installer is available.
- **Marketing landing page.** "230+ tools, 12 integrations" → "220 tools,
  17 integrations" (now matches the registered domain count in
  `apps/core/src/ai/agent.ts`). Dropped the Discord bot claim since only
  Telegram is implemented. Fixed a `Reveal` component bug where
  scroll-animated sections stayed at `opacity: 0` on deep-link /
  back-nav / direct-scroll entries.

---

## 0.1.0 — Public Alpha

Initial public alpha release. See [talome.dev/docs/changelog](https://talome.dev/docs/changelog) for the full list of features shipped in 0.1.0.
