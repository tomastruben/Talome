# Reddit Launch Drafts

## r/selfhosted

**Title:**
```
[Release] Talome — an AI agent for your home server that installs apps, wires services together, and can modify its own source code
```

**Flair:** Release

**Body:**

```
Hey r/selfhosted,

I've been building Talome for the past year as my answer to the pain of self-hosting. It's an open-source (AGPL-3.0) server management platform with an AI agent as the primary interface — 230+ purpose-built tools across Docker, media (Sonarr/Radarr/Jellyfin), networking, backups, and system monitoring.

**What it does differently:**

- **One message → full media stack.** Say "set up Jellyfin, Sonarr, Radarr, Prowlarr, qBittorrent with my media at /mnt/nas" and a minute later everything is running, wired together, and indexers synced.
- **Self-improvement.** Talome can read and modify its own TypeScript source. Tell it to fix a UI bug, it reads the component, writes the fix, runs the type checker, commits. If types fail it rolls back automatically.
- **Multi-source app store.** Native Talome apps + CasaOS + Umbrel + your own creations, all from one search.
- **Actually open source.** AGPL-3.0, no "community edition", no feature gating.
- **Autonomous monitoring.** Three-layer system catches problems in under 60s, triages, and can fix common issues overnight. Morning summary in the dashboard.

**What it needs:**
- macOS or Linux, 2GB RAM, 5GB disk
- Docker (for managed apps — OrbStack recommended on Mac)
- Your own Anthropic API key

**Install:**
`curl -fsSL https://get.talome.dev | bash`

**Links:**
- Website: https://talome.dev
- GitHub: https://github.com/tomastruben/Talome
- Docs: https://talome.dev/docs
- Discord: https://discord.gg/HK7gFaVRJ

This is a public alpha — there will be rough edges. I'd love feedback, bug reports, and honestly, whatever breaks on your rig. Happy to answer questions in the comments.
```

---

## r/homelab

Shorter, more technical, lead with the demo GIF:

```
[Project] Talome: AI agent + Docker orchestrator for the home lab

230+ tools across Docker, arr stack, Jellyfin, Plex, Pi-hole, Home Assistant, Vaultwarden. Talk to it in English, it executes. Runs natively on Linux/macOS, open source AGPL-3.0, one-command install.

Demo GIF: [link]
Repo: https://github.com/tomastruben/Talome

Happy to answer questions.
```

---

## r/unraid / r/Synology / r/jellyfin / r/sonarr

Tailor per subreddit. Highlight the relevant integration. Read the subreddit rules before posting — most forbid multi-posting the same content.

---

## Rules of thumb

- **Never cross-post** with the same title on the same day. Space posts out over a week.
- **Post in comments too.** If you see a "what's the best self-hosted X" thread, answer the question honestly and mention Talome only if it fits.
- **Never downvote dissent.** It backfires.
- **Follow each subreddit's self-promotion rules.** r/selfhosted requires flair and forbids crossposts from other subs. r/homelab has a Sunday self-promotion thread.
- **First comment should add value**, not repeat the title. Drop a demo GIF or a "how it compares to X" table.
