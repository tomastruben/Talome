# Next Steps — Right Now

> Short, prioritized action list. Start at the top and work down. Each item is concrete and can be done today. For full context, see [`launch-plan.md`](./launch-plan.md).

---

## This week (before anything else)

### 1. Merge the launch-prep branch

The community files, launch plan, and launch copy are sitting on `claude/talome-launch-prep-aCNYb`. They're not live until they're on `main`.

- [ ] Review the branch: https://github.com/tomastruben/Talome/compare/main...claude/talome-launch-prep-aCNYb
- [ ] Open a PR (or fast-forward merge locally) into `main`
- [ ] Once merged, the `SECURITY.md`, issue templates, PR template, and FUNDING button will appear on the GitHub repo

### 2. Set up the Discord server properly

This is the #1 risk. Hundreds of first-time visitors will hit Discord on launch day and the founder is the only moderator right now.

- [ ] Generate a **permanent invite link** (unlimited uses, never expires)
- [ ] Replace `discord.gg/HK7gFaVRJ` everywhere in the repo with the permanent invite
- [ ] Create channels: `#welcome`, `#announcements`, `#general`, `#show-and-tell`, `#help`, `#bug-reports`, `#feature-requests`, `#self-hosting`, `#dev`
- [ ] Create roles: `@maintainer`, `@contributor`, `@early-adopter`
- [ ] Enable verification level **Medium** (phone-verified accounts only)
- [ ] Enable auto-moderation (spam + raid protection)
- [ ] Recruit at least **one** trusted second moderator
- [ ] Add a welcome bot auto-reply linking to `talome.dev/docs` and the FAQ
- [ ] Pin the Code of Conduct in `#welcome`
- [ ] Upload server icon, banner, and description matching `talome.dev`

### 3. Test the installer on fresh VMs

`install.sh` is the single point of failure on launch day. If it breaks on Ubuntu 24.04 at 9 AM on launch day, the launch dies.

- [ ] Fresh install on **Ubuntu 24.04** (most common)
- [ ] Fresh install on **Debian 12**
- [ ] Fresh install on **macOS 14 Sonoma (Apple Silicon)**
- [ ] Fresh install on **macOS 14 Sonoma (Intel)**
- [ ] Fresh install on **Raspberry Pi OS (arm64)**
- [ ] Test `curl -fsSL https://get.talome.dev | bash -s -- update`
- [ ] Test `curl -fsSL https://get.talome.dev | bash -s -- uninstall`
- [ ] Verify `get.talome.dev → talome.dev/install.sh` Vercel redirect resolves correctly
- [ ] For each install: complete the first-run wizard, install Jellyfin from the app store, send one chat message. If any of that breaks, fix it before doing anything else.

### 4. Record the demo video

The single most valuable marketing asset you don't have yet.

- [ ] 60–90 seconds, no talking head — just the screen
- [ ] Script: fresh dashboard → "set up Jellyfin, Sonarr, Radarr, Prowlarr, qBittorrent, media at /mnt/media" → watch the AI execute → open Jellyfin
- [ ] Upload to YouTube (unlisted first for review, then public on launch day)
- [ ] Link the YouTube URL in:
  - `README.md` (replace or augment the current GIF)
  - `docs/launch/twitter-thread.md` tweet 1
  - `docs/launch/show-hn.md`
  - `docs/launch/product-hunt.md` gallery
- [ ] Export a 5-second GIF version for tweet previews
- [ ] Keep a 30-second vertical cut for Shorts / Reels if you want that channel

---

## Next week (after the above is done)

### 5. Cut `v1.0.0`

- [ ] Move everything from the `Unreleased` section of `apps/web/content/docs/changelog.mdx` into a new dated `v1.0.0 — YYYY-MM-DD` section
- [ ] Replace the hardcoded `v0.1.0` at `apps/web/src/components/footer.tsx:55` — read from `package.json` so it never drifts again
- [ ] `git tag v1.0.0 && git push origin v1.0.0` — this triggers `.github/workflows/release.yml` which builds `ghcr.io/tomastruben/talome:1.0.0` and `:latest` for amd64 + arm64
- [ ] Write the **GitHub Release description** on the release page (don't rely on the tag message) — link to the changelog section, highlight top 10 features, include the install command
- [ ] Verify the Docker image works: `docker pull ghcr.io/tomastruben/talome:1.0.0 && docker run ...`

### 6. Polish the marketing site

- [ ] Add an X / Twitter / Bluesky link to `apps/web/src/components/footer.tsx` (and the header nav) once the handle exists
- [ ] Add a small **"Star on GitHub"** CTA to the homepage, above or next to the install command
- [ ] Validate OG previews: paste `https://talome.dev` into https://metatags.io and https://www.opengraph.xyz — confirm the card renders correctly on X, Discord, Slack, LinkedIn
- [ ] Build a `/press` page with logo variants, wordmark, brand colors, screenshots, 50-word and 200-word descriptions
- [ ] Pin 3–4 GitHub issues labeled `good first issue` + `help wanted` so drive-by contributors have an entry point
- [ ] Set GitHub repo **About** topics: `self-hosted`, `ai-agent`, `docker`, `home-server`, `homelab`, `agpl`
- [ ] Enable GitHub **Discussions** with categories: Announcements, Q&A, Ideas, Show and tell

### 7. Finalize the launch copy

Open each file in `docs/launch/` and fill in the blanks.

- [ ] `show-hn.md` — adjust voice to match yours, not mine
- [ ] `reddit.md` — verify it complies with each subreddit's self-promotion rules
- [ ] `twitter-thread.md` — replace `@talomedev` placeholder with the real handle, attach the demo GIF to tweet 1
- [ ] `product-hunt.md` — pick the final tagline, arrange a hunter if needed
- [ ] Write the **"why I built this"** long-form essay — this is your second-wind traffic hook on day 2 or 3

---

## Launch day (T-0)

Don't improvise. The plan is already written in [`launch-plan.md`](./launch-plan.md) §4.

- [ ] 9–11 AM Pacific on a **Tuesday or Wednesday**
- [ ] Submit Show HN → post the first comment within 30 seconds
- [ ] Post to r/selfhosted
- [ ] Publish the X thread
- [ ] Product Hunt goes live at 12:01 AM PT (schedule in advance)
- [ ] Pin the HN URL in Discord `#announcements`
- [ ] Be at the keyboard all day — reply to every comment within 15 minutes
- [ ] Never engage defensively. One angry reply can flag a launch off the front page.

---

## What NOT to do

- Don't cut `v1.0.0` before the installer is verified on all tracked platforms
- Don't launch on a Monday or Friday
- Don't launch without a permanent Discord invite and a second moderator
- Don't launch without the demo video
- Don't delete "negative" comments on HN or Reddit — it makes things worse
- Don't batch-message your friends asking for stars — HN/PH detect this and down-rank
- Don't push to `main` anything that hasn't been tested on a fresh VM

---

## Decision points I need from you

These are things I can't figure out from the repo and you'll need to commit to before the launch can proceed:

1. **Launch date.** Pick a specific Tuesday or Wednesday at least two weeks out. Everything else is scheduled backward from this date.
2. **Social handles.** Do you have `@talomedev` on X? Bluesky? Mastodon? If not, register them now — squatters wait for launches.
3. **A second moderator.** Who is it? Ask them this week.
4. **Press-kit decisions.** One logo or multiple variants? Dark + light? PNG + SVG?
5. **BYO Anthropic key or bundled credits for first N users?** The former is simpler; the latter is friendlier for launch day but costs you money.
6. **Telemetry.** Do you want any install metric at all, or go 100% dark? The answer affects how you measure launch success.

Answer these six questions and the path to launch is deterministic from here.
