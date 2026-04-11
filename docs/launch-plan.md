# Talome Launch Plan

> Goal: a viral public launch that converts developer curiosity into installs, stars, Discord members, and long-term contributors — without a broken first impression.

This document tracks the full launch preparation: what's already in place, what's missing, and what to do on launch day. Treat it as a living checklist. Tick items as they land.

---

## 1. Current State (what's already good)

| Area | Status | Notes |
|---|---|---|
| Marketing site (`talome.dev`) | Live | Next.js 16 + fumadocs, hero video, story, feature tour, app ecosystem, CTA |
| Docs | Live | Getting-started, 12 integration guides, reference, FAQ, changelog |
| Installer | Live | `curl -fsSL https://get.talome.dev \| bash` (Linux/macOS) + PowerShell for Windows |
| Docker image | Ready | GHCR release workflow triggers on `v*` tag (amd64 + arm64) |
| CI | Green | Typecheck + test + build on every push/PR |
| Licensing | Clean | AGPL-3.0, clear legal disclaimers |
| README | Strong | Tagline, install, features, comparison table, community links |
| OG image | Present | `/og-image.png` 1200×630 |
| Sitemap + robots | Present | Covers all docs pages |
| MCP server | Shipped | Auto-sync, documented in README |
| Discord invite | Present | `discord.gg/HK7gFaVRJ` referenced in README, footer, docs |

---

## 2. Gaps Found (must fix before launch)

These were identified during the launch-prep audit. Each one is a concrete, actionable item.

### Repository hygiene

- [ ] **No `SECURITY.md`** — required for responsible disclosure. GitHub surfaces this on the "Security" tab.
- [ ] **No `.github/ISSUE_TEMPLATE/`** — bug reports will land unstructured. Add `bug_report.yml`, `feature_request.yml`, `config.yml`.
- [ ] **No `.github/PULL_REQUEST_TEMPLATE.md`** — contributions won't follow a consistent format.
- [ ] **No `.github/FUNDING.yml`** — opens GitHub Sponsors / Ko-fi / etc.
- [ ] **No `CHANGELOG.md` at repo root** — the marketing-site `changelog.mdx` exists but `Unreleased` section still holds everything. Cut a dated `v1.0.0` entry when you tag.
- [ ] **Footer still shows `v0.1.0`** at `apps/web/src/components/footer.tsx:55`. Either bump it to `v1.0.0` at launch or pull version from `package.json` so it never drifts.
- [ ] **No `CODEOWNERS`** — optional, but helpful if you expect PRs on sensitive paths.

### Marketing site polish

- [ ] **No X / Twitter link** anywhere in header or footer. Add a `@talomedev` (or equivalent) link to `apps/web/src/components/footer.tsx` and `header.tsx`.
- [ ] **No standalone demo video URL** for sharing on socials — `/hero.webm` is only embedded. Upload a 60-second demo to YouTube and link it from the site + README + social posts.
- [ ] **Homepage "Apps" anchor** (`#apps`) needs a quick visual check that it scrolls to the `AppEcosystem` section with enough breathing room.
- [ ] **OG image preview validation** — paste `https://talome.dev` into https://metatags.io and https://www.opengraph.xyz before launch.
- [ ] **`install.sh` and `install.ps1`** — test both on a clean VM one more time (Linux amd64, macOS arm64, Windows 11). This is the single most fragile path on launch day.
- [ ] **Verify `get.talome.dev → install.sh` redirect** is live in Vercel after the next deploy.
- [ ] **Add an explicit "Star the repo" card** on the homepage before launch — on viral launches, social proof from early stars compounds.

### Discord

The invite link is in the repo, but a viral launch brings hundreds of first-time visitors. The server itself must be ready.

- [ ] **Permanent invite link** (unlimited uses, never expires). Use this link everywhere instead of the temporary one.
- [ ] **Channel structure:**
  - `#welcome` (rules + link to docs)
  - `#announcements` (locked, read-only)
  - `#general` (free-form chat)
  - `#show-and-tell` (users showing their Talome setups)
  - `#help` (support questions)
  - `#bug-reports` (points users to GitHub Issues)
  - `#feature-requests` (points users to GitHub Discussions)
  - `#self-hosting` (off-topic / adjacent topics)
  - `#dev` (for contributors discussing PRs)
- [ ] **Verified roles:** `@maintainer`, `@contributor`, `@early-adopter` (role badge for people who installed during alpha).
- [ ] **Welcome bot / auto-reply** linking to docs and FAQ (reduces repetitive Q&A).
- [ ] **Code-of-conduct link** pinned in `#welcome`.
- [ ] **Server icon, banner, description** match `talome.dev` branding.
- [ ] **Moderation tools** — at least one trusted moderator besides the founder so bad actors don't ruin launch day.
- [ ] **Auto-moderation** enabled for spam, raid protection.
- [ ] **Verification level** set to "Medium" or "High" so drive-by spam accounts can't post immediately.

### GitHub repo preparedness

- [ ] **Pin 3-4 top issues** that invite contribution ("good first issue" + "help wanted" labels).
- [ ] **Labels**: at minimum `bug`, `feature`, `docs`, `good first issue`, `help wanted`, `needs repro`, `wontfix`, `duplicate`.
- [ ] **GitHub Discussions enabled** with categories: Announcements, Q&A, Ideas, Show and tell.
- [ ] **About section** of the GitHub repo: topics (`self-hosted`, `ai-agent`, `docker`, `home-server`, `homelab`, `agpl`), website link, description matching README tagline.
- [ ] **First release `v1.0.0`** tagged and pushed → triggers `release.yml` → Docker image lives on `ghcr.io/tomastruben/talome:1.0.0` + `latest`.
- [ ] **Release notes** written on the GitHub release page — not just the tag message. Link to changelog, highlight top 10 features, include the one-liner install.
- [ ] **Pinned README install command works** on a fresh checkout.
- [ ] **`.github/FUNDING.yml`** for sponsorship button.

### Launch content (write these now, don't improvise on launch day)

- [ ] **Show HN title + comment** drafted. Good pattern: `Show HN: Talome – An AI that manages your home server and rewrites its own code`. The first comment should be the "why I built this" story, not marketing copy.
- [ ] **r/selfhosted post** drafted. Follow the subreddit rules — `[Release]` or `[Project]` flair, no link-baiting titles. Lead with the demo GIF.
- [ ] **r/homelab, r/homeassistant, r/unraid, r/jellyfin** — tailored variants.
- [ ] **X / Twitter launch thread** drafted (6–10 tweets): hook → problem → solution → demo clip → features → install command → star CTA.
- [ ] **Product Hunt submission** drafted (hunter, tagline, description, gallery, maker comment). Launch on a Tuesday or Wednesday, not Monday.
- [ ] **Lobsters post** — if you have an invite, `#self-hosted` tag.
- [ ] **YouTube demo video** (60–120 seconds) showing the one-message media-stack setup end-to-end.
- [ ] **Blog post / essay** — long-form "why I built this" piece on your own site or dev.to explaining the self-improvement angle (this is the most unique thing and should be the narrative hook).
- [ ] **Email to personal network** — friends who will star, install, and post early feedback on launch day.

### Assets to prepare

- [ ] **Hero GIF** optimized for GitHub README preview (exists, but re-check file size).
- [ ] **Short demo clip (60 s)** — for Twitter/X, Bluesky, Mastodon.
- [ ] **Screenshots** — dashboard, chat, app store, app creation (one per feature).
- [ ] **Press kit** at `talome.dev/press` — logo variants, wordmark, brand colors, screenshots, one-liner, 50-word description, 200-word description. Currently only `/logos` exists.
- [ ] **Comparison table image** — the "How It Compares" table in README rendered as a share-friendly PNG for Twitter.

### Reliability / safety for launch-day traffic

- [ ] **Load-test `get.talome.dev`** — this is the single point of failure. If install.sh 404s or is slow, launch dies. Verify Vercel handles a traffic spike (should be fine, but confirm the redirect path).
- [ ] **Anthropic API key guidance** — the installer doesn't ship an API key. Make sure the onboarding clearly explains this is BYO-key, why, and how to get one. Add this to the top of `docs/getting-started/installation.mdx` if not already there.
- [ ] **First-run wizard** — double-check the dashboard's first-run experience on a fresh install. This is what 90% of launch-day visitors will see.
- [ ] **Error-reporting opt-in** — if the app crashes on launch day for a popular OS, you need to know. Make sure telemetry (if any) is clearly opt-in and documented.
- [ ] **Fresh install on:**
  - [ ] Ubuntu 24.04 (most common Linux)
  - [ ] Debian 12
  - [ ] macOS 14 Sonoma (Intel)
  - [ ] macOS 14 Sonoma (Apple Silicon)
  - [ ] Raspberry Pi OS (arm64)
  - [ ] Unraid
  - [ ] Synology DSM (if supported)
- [ ] **Uninstall flow** works cleanly — users who try and bounce should not leave orphaned files/containers. (You already have `curl ... | bash -s -- uninstall` — verify it.)

### Legal / trust

- [ ] **Privacy policy** — linked in footer, exists at `/docs/legal/privacy-policy`. Re-read once to make sure it reflects reality (especially around AI provider data handling — Anthropic sees every chat message).
- [ ] **Terms of service** — linked in footer, exists. Re-read.
- [ ] **"Does it phone home?"** — add a clear statement to the FAQ: what leaves the box by default (probably just the install.sh fetch and your chosen AI provider's API).
- [ ] **Media copyright disclaimer** — already in README/ToS. Make sure it's also prominent on the Sonarr/Radarr guide pages so you don't get a DMCA-adjacent PR disaster.

---

## 3. What Can Be Done Right Now (inside the repo)

Concrete tasks that don't require leaving this editor:

1. **Add `SECURITY.md`** with a responsible-disclosure email.
2. **Add `.github/ISSUE_TEMPLATE/`** (bug, feature, config.yml).
3. **Add `.github/PULL_REQUEST_TEMPLATE.md`**.
4. **Add `.github/FUNDING.yml`** (even if only GitHub Sponsors).
5. **Add `X / Twitter` link** to `apps/web/src/components/footer.tsx` (and header nav).
6. **Pull footer version from `package.json`** so `v0.1.0` stops drifting.
7. **Fill in changelog `v1.0.0` section** with a dated release.
8. **Write draft launch copy** in `docs/launch/` (Show HN, Reddit, Twitter thread, PH description).
9. **Double-check Discord invite link** and replace with a permanent-never-expires one everywhere.
10. **Add a "Star on GitHub" CTA** to the homepage — small, unobtrusive, above the install command.

Items 1–7 are repo changes you can make today. Items 8–9 you can stage in the repo as drafts. Item 10 is a site edit.

---

## 4. T-minus Launch Timeline

> Adjust the offsets to your real calendar — the point is the ordering, not the specific days.

**T-14 days — Preparation**
- All "repository hygiene" items merged.
- Discord server restructured and permanent invite generated.
- Launch copy drafted for every channel.
- Clean-VM install tested on 5+ platforms.

**T-7 days — Soft launch**
- Post in Discord to existing members: "launch is coming, please test & star".
- Share with ~20 trusted friends for last-pass feedback.
- Fix anything they find.
- Record demo video.

**T-3 days — Content lock**
- Tag `v1.0.0`. Release workflow pushes Docker image to GHCR.
- Write GitHub release notes.
- Schedule Product Hunt submission for the chosen Tuesday/Wednesday.
- Queue social posts (but don't publish yet).

**T-1 day — Dress rehearsal**
- Final install on all tracked platforms.
- Check `get.talome.dev` serves the correct `install.sh`.
- Check Discord invite resolves to a server with all channels live.
- Check the OG image renders correctly in previews.
- Check every link in the README.

**Launch day (early morning your timezone, 9–11 AM PT is best for HN/PH/Reddit)**
- Publish Show HN (title above).
- Publish r/selfhosted post.
- Publish X thread.
- Product Hunt goes live at 12:01 AM PT (automated).
- Pin the HN link in Discord `#announcements`.
- Be online all day to answer every question within 15 minutes. HN and Reddit reward responsiveness more than any SEO trick.

**T+1 to T+7 days — Momentum**
- Thank every early adopter personally in Discord.
- Cross-post the HN URL to Lobsters, Lemmy `c/selfhosted`, Mastodon `#selfhosting`, Bluesky.
- Publish the "why I built this" essay on day 2 or 3 as a fresh angle (second wind of traffic).
- Open a retrospective issue: what broke, what worked, what to fix.

---

## 5. Viral Hooks (why the launch can pop)

Talome has three hooks that make it genuinely interesting to developers. Lead with these:

1. **Self-improvement is rare.** Very few open-source projects let the AI rewrite their own source. This is a novelty hook — the kind of thing people screenshot and share.
2. **One command → full media stack.** The demo video should show this end-to-end. It's visceral and concrete.
3. **AGPL, not "source available".** Self-hosters are allergic to fake-open-source. Say "truly open source, AGPL-3.0" prominently — it's a differentiator vs. Umbrel's PolyForm NC and others.

Avoid these anti-hooks:
- "AI-powered" as a selling point alone — developers are saturated. Lead with the specific capability (rewrites its own code), not the category.
- Feature-list bullet walls in social posts. Lead with ONE sentence + ONE GIF.

---

## 6. Success Metrics

Don't judge the launch by vanity. Track:

| Metric | Baseline | 24h target | 7d target |
|---|---|---|---|
| GitHub stars | ~?? | +500 | +2000 |
| GitHub issues (signal of real users) | — | 10+ | 30+ |
| Discord members | ~?? | +200 | +500 |
| HN front page | — | yes | — |
| Successful installs (if you track telemetry) | — | 500+ | 2000+ |
| PRs from strangers | — | 1+ | 5+ |

A launch is a success if **three weeks later, unprompted strangers are using the project and filing bugs**. Everything else is noise.

---

## 7. Risks and Mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| `install.sh` fails on a popular distro | High | Test on 5+ platforms before T-1 day |
| Anthropic rate-limits first users | Medium | Crystal-clear BYO-key messaging |
| Discord server overrun by spam | Medium | Verification level, auto-mod, second moderator |
| A DMCA-adjacent complaint about arr tooling | Low | Prominent disclaimer, no piracy copy in docs |
| Vercel redirect goes down | Low | Pre-cache install.sh, test redirect pre-launch |
| A critical bug found on launch day | High | Be online, ship a fix, push a new Docker tag, communicate in Discord |
| HN flag-spiral from a critic | Medium | Engage calmly, never defensively; one angry reply kills a launch |

---

## 8. After the Launch

Whatever happens, preserve momentum:

- Publish weekly changelog entries (this is how projects stay interesting after launch week).
- Turn the best Discord conversations into docs.
- Name every early contributor in the README "contributors" section.
- Do a "one month later" retrospective post — HN and Reddit love these.

---

**Owner:** Tomas Truben. **Status:** living document — update as items are completed.
