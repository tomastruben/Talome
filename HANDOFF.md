# Talome local handoff

Updated 2026-10-02 after the Codex desktop UI pass.

## Working copies

- Continue in `/Volumes/Media Hub/dev/Talome-wt/combine`, branch `parity/combine`.
- Production source: `/Volumes/Media Hub/Talome-Data/server`; dashboard on port 3000.
- Original Claude handoff commit: `2e606ca`. Desktop UI changes are committed locally through `fe57ba96` and deployed on port 3000. Nothing was pushed to GitHub.
- `AGENTS.md` already exists as a regular file. It was preserved. Read it and `CLAUDE.md` before changes; do not replace either without saving the original.
- Existing uncommitted `apps/web/.source/browser.ts` and `server.ts` changes belong to the earlier work and were preserved in both working copies.

## User rules

Never discard or overwrite work without saving it first. No sudo. Ask before pushing to any remote except `mac-mini-local`. Never use the real password. The sandbox test account is only for local hosts.

For this UI session the user explicitly requested the signed-in `http://localhost:3000` instance and asked not to use the sandbox. Use the internal browser and avoid changing real application data during visual checks.

## Deployment on port 3000

1. Back up the SQLite DB with `VACUUM INTO` and archive the server directory before changes. Resolve DATABASE_PATH from the core environment without printing secrets.
2. From `Talome-Data/server`, fetch the worktree and merge with `git merge --ff-only`.
3. Run `pnpm install --frozen-lockfile`, then `pnpm build`.
4. Restart with `launchctl kickstart -k gui/$(id -u)/dev.talome`.
5. Check `/api/health` after startup; db and docker should both be ok.

Use `PATH=/usr/local/bin:$PATH` for local builds and tests: the service uses Node 22. The default Homebrew Node 25 causes SQLite ABI and test localStorage problems.

Backup from this session: `/Volumes/Media Hub/Talome-Data/backups/codex-desktop-ui-20261002-230437` (DB VACUUM backup, server tar excluding node_modules, and restore notes).

## Sandbox and MCP

For a future sandbox session: `TALOME_SANDBOX_HOST=127.0.0.1 scripts/sandbox.sh core` and `... dashboard` use port 3210. Use 127.0.0.1 rather than localhost to avoid clearing production sign-in.

Claude's `.mcp.json` is not Codex CLI configuration. If tools are unavailable in a new Codex session, configure the Talome stdio launcher `apps/core/mcp-launch.sh` in `~/.codex/config.toml`. Do not expose credentials in logs.

## Desktop UI pass

- App Store, Services and Audiobooks publish their selected view to the window title instead of duplicating it in a toolbar heading.
- New automation and Check updates belong in the app toolbar.
- Toolbar button capsules include Radix trigger slots so filter, menu and other buttons have consistent shapes.
- Search collapses to a named button below 32rem of content width. Opening focuses the field and temporarily hides secondary toolbar controls so the title and search stay on one row; Escape/close preserves the query and restores controls.
- Narrow Media windows combine view navigation, sorting and filters in one menu. Non-library views retain navigation. Narrow App Store windows combine sources and categories in one menu.
- Native app navigation and primary actions use the shared toolbar; layout grids respond to the native content container.
- Compact Media/App Store headers stay on one row. Audiobooks keeps title and controls together when its sidebar is visible. Wider windows retain sidebar navigation. Classic mode retains tabs.

Validation: affected dashboard TypeScript check, focused regression suites, full production build, and health endpoint passed. Browser checks used real Media and App Store data plus Services, Automations dialog and Budget Compass navigation. No automation was created during checks.

## Remaining items from Claude

- Re-enable the two paused automations after identifying the intended jobs and checking their current state; this UI pass did not change them.
- Anthropic API key was reported out of credit; not revalidated or changed.
- Decide how to handle generated `apps/web/.source` changes.
- Further review of Media layout and native apps can continue with real data.
