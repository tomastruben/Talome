# X / Twitter Launch Thread Draft

Post the thread from the `@talomedev` (or personal) account. Keep each tweet punchy. Media on tweets 1, 3, and 6.

---

**1/ (hook + demo)**
```
For a year I've been building an AI that runs my home server.

Today it's open source.

Talome installs apps, wires services together, monitors containers, and can rewrite its own code to get better.

One conversation replaces an afternoon of compose files.

🧵↓
```
*Attach: 60s demo video*

**2/ (the problem)**
```
Every self-hosting platform solves "install apps" but leaves you wiring services together by hand.

Jellyfin needs Sonarr to know its media path.
Sonarr needs qBittorrent as a download client.
Prowlarr needs to push indexers to both.

That's a wiki for every. single. stack.
```

**3/ (the demo)**
```
With Talome, that whole setup is one message:

"Set up a media stack with Jellyfin, Sonarr, Radarr, Prowlarr, and qBittorrent. Media is at /mnt/nas."

60 seconds later, every service is running and configured. URLs in the chat reply.
```
*Attach: screenshot of the chat reply*

**4/ (230+ tools)**
```
Behind that one message, the AI ran:
• search_apps
• install_app (×5)
• wire_apps
• arr_add_root_folder
• arr_add_download_client
• arr_sync_indexers_from_prowlarr
• check_service_health

230+ tools across Docker, arr stack, Jellyfin, Plex, Pi-hole, Home Assistant.
```

**5/ (the novel part)**
```
The part I'm most excited about:

Talome can read and modify its OWN TypeScript source code.

Tell it "the dashboard sidebar feels cluttered" → it reads the component, writes a fix, runs the type checker, commits.

If types fail, it rolls back automatically. Every change is reversible.
```

**6/ (autonomous)**
```
It's also watching 24/7.

If a container crashes at 3AM, the three-layer monitor catches it in <60s, a fast model triages severity, and a reasoning model diagnoses and fixes it.

You wake up to a summary, not a page.
```
*Attach: screenshot of the morning summary*

**7/ (open source, stack)**
```
Stack:
• TypeScript monorepo
• Hono backend, Next.js 16 frontend
• SQLite + Drizzle
• Vercel AI SDK + Anthropic Claude
• AGPL-3.0, not "source available"

Runs natively on Linux/macOS. Needs Docker for managed apps. BYO API key.
```

**8/ (install)**
```
One command:

curl -fsSL https://get.talome.dev | bash

Or visit https://talome.dev for docs, demo, and the full feature tour.
```

**9/ (ask)**
```
This is a public alpha. There will be rough edges.

If you're into self-hosting, home labs, or AI agents with real tools — I'd love your feedback, bug reports, and stars.

⭐ https://github.com/tomastruben/Talome
💬 https://discord.gg/HK7gFaVRJ
```

---

## Variants to queue up over the following week

- **Self-improvement angle thread** (long-form, post day 3).
- **Comparison thread** vs. Umbrel/CasaOS (post day 5, engagement-friendly).
- **"How I built this"** technical thread (post week 2).
- **User-submitted setup showcase** (retweet/reply, ongoing).

## Cross-post the same thread, unchanged, to:

- Bluesky `@talomedev.bsky.social`
- Mastodon `@talomedev@fosstodon.org`
- LinkedIn (tighter, remove emojis, more professional tone)
