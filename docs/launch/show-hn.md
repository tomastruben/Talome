# Show HN Draft

**Title (under 80 chars):**
```
Show HN: Talome – An AI that manages your home server and rewrites its own code
```

**URL:** https://talome.dev

**First comment (post immediately after submitting):**

```
Hi HN, I'm Tomas, the author of Talome.

I've been self-hosting for years and every other platform (CasaOS, Umbrel, TrueNAS) solved the "install apps" problem but left me writing compose files, wiring services together, and debugging networking by hand. I wanted something that could actually *do* the work — not just give me a prettier button to click.

Talome is an AI agent with 230+ purpose-built tools for Docker, media servers (Sonarr/Radarr/Jellyfin/Plex), networking, backups, and system monitoring. You talk to it in plain English and it runs the commands. "Set up a media stack with Jellyfin, Sonarr, Radarr, Prowlarr, and qBittorrent" becomes one message — and a minute later every service is running, connected, with indexers synced and root folders configured.

The thing that I think is genuinely novel: Talome can **read and modify its own TypeScript source code**. You can tell it "the dashboard feels cluttered, simplify the sidebar" and it reads the component, writes a diff, runs `tsc --noEmit`, and if the types still pass, commits the change. If they don't pass, it rolls back automatically via `git stash`. Every change is reversible.

Tech stack:
- TypeScript monorepo (Hono backend, Next.js 16 frontend)
- Vercel AI SDK + Anthropic Claude (BYO API key)
- SQLite + Drizzle ORM
- Multi-source app store aggregating Talome native + CasaOS + Umbrel
- MCP server so you can also drive it from Claude Code / Cursor / Claude Desktop

It's AGPL-3.0. One-command install (`curl -fsSL https://get.talome.dev | bash`), runs natively on Linux/macOS, needs Docker for the managed apps, and asks you for an Anthropic API key on first boot.

This is a public alpha. There will be rough edges. I would love feedback, bug reports, and pull requests. Discord: https://discord.gg/HK7gFaVRJ

Happy to answer any questions.
```

**Tips for launch day:**

- Submit between 9–11 AM Pacific on a Tuesday/Wednesday/Thursday.
- Post the first comment within 30 seconds of submitting.
- Respond to every comment within 15 minutes for the first 4 hours.
- Don't get defensive. Every thoughtful reply, even to harsh criticism, compounds.
- If flagged, do not message dang. Let the post recover on its own.
- If it hits the front page, pin the URL in Discord `#announcements`.
