# Talome improvement audit — 5 September 2026

Work was performed in the chosen running-server checkout, `/Users/tomas/.talome/server` → `/Volumes/Media Hub/Talome-Data/server`. The separate `/Volumes/Media Hub/dev/Talome` copy was not touched. Pre-existing uncommitted source, tests, automations and files were preserved. No installed application was removed, reconfigured, or reset.

## Architecture and evidence

- The launch agent `dev.talome` runs the existing build-mode supervisor through `~/Library/Application Support/Talome/launch.sh`.
- Next.js dashboard on port 3000 hosts both classic navigation and desktop windows. Built-in apps and generated native applications render in same-origin iframes in desktop mode; external service UIs retain their own document boundary.
- Hono core on port 4000 owns authenticated APIs, AI creation, SQLite, app lifecycle and Docker integration. The terminal daemon has its own supervised process on port 4001.
- The active database is `~/.talome/data/talome.db`. Generated working sources (`~/.talome/generated-apps`), user-app catalog sources (`~/.talome/user-apps/apps`) and installed runtime data (`~/.talome/app-data`) are separate. The inspected database contained 14 installed apps and five user-app catalog entries.
- Talome already has a shared shadcn-based native renderer, semantic tokens, AppSpec data sources and typed actions exposed to both users and agents. This work extends that architecture.
- Existing Strategy Intelligence and Stopwatch artifacts demonstrate meaningful domain actions and Python services. Weather Guard and Server Weather still expose generic lifecycle surfaces. Read-only validation of both generated Compose configurations passed, and all five installed native contracts passed the stronger schema.

## Implemented fixes

| Priority | Problem | Result |
| --- | --- | --- |
| P1 | Same-app iframe links replaced the iframe URL, losing client router state; activation and explicit navigation shared reset behavior. | Same-app links use their local router. Dock/Launchpad activate or restore without resetting. Explicit deep links still navigate. Each generated native app is its own destination. |
| P1 | Embedded Back could traverse shared browser history; client-side routes were not reliably saved with desktop state. | Settings/App Store use safe parent routes in embedded mode. Same-origin, source-checked route messages persist the current route separately from iframe src; full desktop reload restores details. |
| P1 | Port Save omitted its service; Compose array environments and nontrivial port syntax were misread/corrupted. | Service and exact mapping are submitted; shared parsing preserves values containing `=`, inherited variables, protocols, bind addresses and long port syntax. Invalid input fails before writes. Audit records keys/counts rather than submitted environment values. |
| P1 | Active creator completion could report success without runnable artifacts and lose newer generated actions during publishing. | Interactive and headless paths validate actual Compose/AppSpec files and applicable TypeScript packages, block failed publication, retain check results and preserve the generated contract. Staged apps require a native contract. |
| P1 | Generated native contracts accepted ambiguous IDs and undeclared row-action input references. | Schema checks reject duplicate surface/block/input IDs and invalid row bindings. Existing installed contracts remain compatible. |
| P2 | Creation launch paths broke on spaces; completed planning still required an unused API key; error output could count as execution success. | Literal shell arguments, private unique prompt files, conditional API-key requirement and faithful runner success handling. |
| P2 | Generated app titles were truncated and final tabs clipped on phones; large repeated padding and header icons consumed compact windows. | Shared renderer shows wrapping titles, compact icons, reduced redundant padding, container-aware action layout, scrollable named tabs, pending spinner and Retry app data. All native apps inherit these changes. |
| P2 | Window controls had tiny targets, keyboard focus did not activate a window, and Resize did nothing from the keyboard. | The recognizable 14px circles now sit in 28px targets with visible focus and labels. Keyboard focus activates windows. Arrow keys resize by 16px, Shift+arrows by 64px, respecting bounds. |
| P2 | Design knowledge was largely free-text prompt guidance. | Five versioned compositions backed by shipped native/shadcn components expose data shape, primary action, states, responsive behavior, references and verification expectations. Keyword discovery and generated instruction documents share one catalog and hash. |

The composition endpoint is `GET /api/apps/design-patterns?intent=stopwatch%20pause`, under the existing API authentication. It returns `focused-task` with native blocks and behavior expectations. Unknown vocabulary yields no invented match. Tests check real reference files, component IDs, ranking and prompt/JSON agreement.

The catalog adapts Astryx's authored metadata and synonym-based discovery idea, not a hypothetical public Intent API. It retains shadcn; no Astryx dependency was installed. Research references: [Astryx CLI](https://astryx.atmeta.com/docs/cli), [search implementation](https://github.com/facebook/astryx/blob/main/packages/cli/api/search/search.mjs), [template contribution guidance](https://github.com/facebook/astryx/wiki/Contributing-Templates).

## Validation

- Shared types, core TypeScript compilation and Next.js production build passed. Targeted frontend ESLint and `git diff --check` passed.
- Final core suite: **40 files, 473 tests passed**, using a disposable test-only secret. Final dashboard suite: **45 files, 197 tests passed**. Focused checks include actual shell quoting, malformed/missing Compose, stale publishing contracts, configuration edits and desktop navigation.
- Dashboard tests emit jsdom's expected unsupported-document-navigation diagnostics; no tests fail. Earlier auth/crypto failures caused by running without a test secret disappeared when configured correctly.
- Authenticated rendered QA used the Codex in-app browser through CUA. Standalone Playwright was available but had no authenticated session; its bundled Chromium was absent, while installed Chrome could render the login page. No production credentials were read or changed.
- Browser page identity, nonblank content, no framework error overlay, screenshot evidence and target interactions were checked at **390×844 phone**, **768×1024 tablet**, **1440×1000 desktop**, and a 520px compact native-window width. Screenshots were emitted in the task; they are not checked into source.
- Phone: Strategy Intelligence's full title fits, Paper tab is reachable and opens its real panel. Tablet: readable content without page-level horizontal overflow. These checks do not execute financial/research actions.
- Desktop: Settings → Legal & Disclaimer stays in the existing iframe (`src` remains Settings while local routing changes). Dock activation and minimize/restore retain the detail. Full desktop reload restores `/dashboard/settings/legal`. Back returns to Settings while the outer URL remains `/dashboard/desktop`.
- Keyboard Resize changed Settings from 720px to 736px; larger-step shrinking was exercised on the generated application. Bounds are covered by unit tests.
- Configuration: edited host port to `70000`; Save displayed “Enter a whole host port from 1 to 65535.” Cancel restored `5011`. No valid live configuration save was made; backend and component tests verify the valid write contract. Phone labels and wrapping were inspected.
- An intermittent `MutationObserver.observe` error appeared during whole-desktop reloads with iframes, with no source URL/stack. A fresh-tab Settings navigation/restoration/Back replay returned no console errors, but the final multiple-window reload reproduced it. All inspected windows still rendered and controls worked. The only application-owned observer found guards its element. Attribution between dependency/frame lifecycle and browser instrumentation remains unresolved; console health is qualified, not an unconditional pass.

## Runtime and rollback

Core and dashboard were rebuilt in the existing checkout, then restarted through their existing supervisor. Docker app data was not touched. The terminal daemon was also restored by the existing supervision lifecycle after core restart. Final health check at 2026-09-05 21:59:42 UTC: dashboard HTTP 200; core reports status/db/Docker ok. Supervisor reports core PID 91771, dashboard PID 92555, and terminal daemon PID 91865 all healthy, with zero consecutive failures.

Pre-build generated artifacts were copied to `/tmp/talome-review/runtime-backup/` (dashboard `.next` and core `dist`). Build/test logs are in `/tmp/talome-review/`. These are temporary recovery/evidence files, not a source-control backup or a durable deployment mechanism.

## Remaining work and limits

- Completion now has meaningful structural/executable checks, but rendered evidence is still supplied through Markdown. An isolated browser runner should independently execute declared workflows against disposable app data and validate observable outcomes; this change does not claim to have built that runner.
- No new app was generated end-to-end using an AI subscription during this pass. Actual existing apps were inspected and their generated files validated; tests cover creation/publishing failure and success cases.
- Weather Guard/Server Weather generic lifecycle surfaces and Stopwatch's static installed session source need app-specific implementation. Stopwatch's existing pending validation report was not rewritten to manufacture success.
- App configuration still requires recreation for Compose changes to apply. Port ranges/unresolved variables remain deliberately read-only; external concurrent file edits lack revision conflict detection.
- This pass does not redesign every app, prove virality, audit every permission combination, or certify every mobile browser. Real touch-device and broader accessibility testing remain useful follow-ups.

Detailed creator evidence: [creator-validation-audit.md](creator-validation-audit.md).

## Second pass — 6 September 2026

The follow-up supersedes the unresolved observer and Weather Guard items above. Creator browser validation is documented separately in the creator audit.

### Iframe observer attribution

An early app-world wrapper around `MutationObserver.prototype.observe` found no failing Talome call. More decisively, a static page with two same-origin iframes and **zero scripts** reproduced 16 identical `observe`/not-Node errors across ten Codex in-app browser reloads. The same page produced zero errors across ten standalone Chrome reloads. A separate isolated Talome desktop with Settings and a native app also produced zero errors across twenty standalone Chrome reloads. The error is attributable to browser instrumentation in this environment; no speculative application/dependency patch was applied. The browser tool did not expose a source stack.

The zero-script reproduction is retained in `scripts/observer-isolation.mjs`. Temporary full-app instrumentation and evidence: `/tmp/talome-review/observer-proxy.cjs`, `observer-trace.cjs`, `observer-trace.log`, and `observer-traces.json`. API traffic in the full-app probes was intercepted, websockets/external traffic blocked, and no production credentials used. Diagnostic servers were stopped after testing.

### Native window identity

Native routes now match installed application identities using the full store/app route, retaining container identities used by Launchpad. Unlisted native apps have distinct fallback identities; later installation adopts that identity without a duplicate window. Relative native deep links restore, older generic persisted identities migrate, and route-state messages must belong to the source window's exact native app. Focused tests cover those cases.

Independent rendered regression passed six checks on the final production build at 1440×1000: differing container/app identities, query/hash restoration after whole-desktop reload, Launchpad reuse with the same document retained, explicit cross-store native navigation into a separate window, and fallback adoption without reload/duplication. Console/page errors were zero. Fixtures intercepted all APIs, blocked websockets/external requests and pointed the isolated server at closed backend port 9. The temporary server/browser were stopped. Evidence: `/tmp/talome-review/native-navigation-regression.json`, `.cjs`, `native-navigation-separate-windows.png`, and `native-navigation-fallback-adoption.png`.

### Server Weather Guard

The approved contract was upgraded from revision 1 to 2. Overview uses current Talome `/api/system` measurements for CPU, memory and mounted storage. Containers uses current `/api/containers` state/statistics. Missing statistics are shown as missing, and CPU values use an explicit 0–100 label without the ratio/percent ambiguity. An explanation action supplies read-only diagnostic context.

The old analyzer generates synthetic incidents (633 of the 660 stored rows explicitly marked simulated at inspection; 27 unmarked rows are not independently verified). It also seeds random history without a marker. Consequently the new UI excludes its stress/forecast outputs, places a prominent provenance warning before preserved history, and never labels unmarked records verified. The existing worker/database were not changed. `weather-guard_url` was set to the verified existing local backend `http://127.0.0.1:5001` to read that history; no Docker or service configuration changed.

Publication used revision/source/connection preconditions and retained backups under `/tmp/talome-weather-guard-upgrade/`. Talome's data-source executor resolved 100 history rows after publication. Live authenticated browser QA verified real readings, container rows, provenance text, search/empty/recovery, phone 390×844, tablet 768×1024 and desktop 1440×1000. Page-level horizontal overflow was absent; the wide container table has its own horizontal scroller. App console errors/warnings were empty. No assistant action, restart, deletion or configuration action was executed during UI QA.

Shared activity lists now use domain-specific search/filter/empty labels rather than budget terminology, honor non-budget icons and fit compact containers. Native app headers use the same metadata-aware icon resolution as the app catalog.

### Final validation and publication boundary

The final core suite passed **511 tests across 45 files** with a disposable test-only secret; dashboard passed **205 tests across 47 files**, plus the final icon/runtime activity check (7 tests). Core typecheck, core production build and the final dashboard production build passed. The standalone browser-process tests execute real child processes to verify stdin transport, credential exclusion, missing tooling/crashes, output limits, and a deadline that kills a hung runner and its descendant.

Independent review also closed a direct app-creation path traversal: app IDs now pass a slug check at the store boundary before any database/filesystem access. Traversal, absolute paths, separators, NULs and oversized identifiers are rejected. Deletion/export and other path consumers were not expanded into a general security audit.

Creator browser evidence is produced by fresh application-owned orchestration against a private source snapshot. Hashes bind file/spec/renderer/harness content; they are **not signatures or independent proof of execution**. Publication rejects forged provenance flags, symlinks, stale revisions and unexplained destination files rather than deleting existing user data. The browser check intercepts client API/external/websocket traffic; it is not an operating-system sandbox against arbitrary malicious code running as the same user. Real generated service behavior/action effects remain explicitly unverified. See the creator audit for final report paths and coverage.

Final runtime health at **2026-09-05 22:30:42 UTC** (6 September locally): core PID 99276, dashboard PID 96781 and terminal daemon PID 99346 all healthy with zero consecutive failures. Core reports database/Docker OK and dashboard returns HTTP 200. Targeted final frontend lint and `git diff --check` passed. Core/dashboard were restarted through existing supervision; generated services and app data were not restarted or reset.

## Third pass — functional and visual improvements, 6 September 2026

This pass addresses the reported completed-download widget defect and extends the previous audit with current CPU sampling, Launchpad improvements and a real Stopwatch workflow. It supersedes the static Stopwatch and always-skipped backend validation limitations above for the reviewed Stopwatch adapter only.

### Downloads and system widgets

The live desktop showed two queue entries at 100% as active while Media already called both complete. The shared download classifier now distinguishes transferring, waiting, attention, importing and completed entries. The desktop widget, Control Center and Media badge use that same classification. Completed entries remain available in the full queue; waiting/importing/problem states remain visible in the summary. Download completion is not proof of successful library import.

Progress no longer rounds 99.99% up to 100% in active rows. Notifications require an observed transition into completion/import processing; disappearing or removed entries and initial page loading do not produce false completion notifications. Failed or malformed downloads responses display a retry state instead of pretending the queue is empty. Media navigation now has accessible tab names and visible labels where space allows.

CPU previously averaged cumulative operating-system counters since boot, explaining the near-constant 13.1% reading. It now samples counter differences between readings, weights all cores, retains the last result for duplicate samples and handles counter resets. Live desktop readings changed through 24.3%, 27.0%, 33.2% and 44.8% during verification.

After deployment, authenticated live UI inspection confirmed **no active downloads, two completed**, matching both Control Center views. Media retained both complete entries and its Downloads badge no longer counted them as pending. No download action or removal was performed.

### Launchpad

Launchpad now provides app-name search with clear/no-match recovery, Enter to launch the first matching app, search reset on reopening, contained keyboard focus, Escape dismissal and focus return. Built-in apps remain usable while installed apps load or fail, with a working retry state. A responsive tile grid, readable two-line names, a persistent search area and consistent 28px app glyphs improve scanning.

Ten rendered checks passed on the final build at 1440×1000, 768×650 and 700×600. These include 25 Tab presses, built-in and installed launch identity, empty/loading/error recovery and measured glyph size. No unexpected browser errors or horizontal overflow occurred. The isolated run used API fixtures and blocked external traffic; its temporary browser/server were stopped. Live authenticated verification additionally confirmed search finds Stopwatch and Escape restores focus to Launchpad.

Evidence: `/tmp/talome-review-third/launchpad-qa.json`, `launchpad-review.md`, `launchpad-regression.cjs`, and `launchpad-after-{1440,768,700}.png`. Download fixture evidence: `/tmp/talome-review-third/download-regression.json` and `download-regression.cjs` (six checks, zero browser errors).

### Stopwatch: real service and native controls

Inspection found stale Node source in the installed catalog directory, while the actual container already ran a Python service on port 5012 with named volume `stopwatch-data`. Maintained source now lives in `apps/stopwatch`; its compatibility contract preserves that existing service layout.

The service now durably recovers interrupted sessions into a paused state, rolls back failed writes and reports failure, shuts down without the earlier SIGTERM deadlock, and avoids reverse-DNS startup stalls. Renaming preserves timing state. Reset requires explicit confirmation at the native contract and backend. The external browser UI freezes safely when disconnected, supports retry, prevents late reads from overwriting newer actions and disables controls while an action is pending.

Native revision 2 reads the real session API and exposes start/resume, lap, pause, confirmed reset, naming and review. Its icon now resolves to a clock. The approved spec and catalog metadata were updated after the new container passed health and session-preservation checks. The missing local API connection was configured. Both the catalog source and the original running source now hold the reviewed implementation; old creator research/design reports remain unchanged.

Deployment preserved the original image under `stopwatch:before-talome-improvements`, source/metadata and volume/session backups under `/tmp/talome-stopwatch-upgrade`. The container retained its Compose project, port, limits and named volume. Before/after elapsed time, label, laps and running state were equal. No production start, lap or reset action was used for testing. The authenticated live native page displayed the actual paused session and had no console errors/warnings.

Verification comprised **37 Python tests**, **8 standalone real-backend browser checks**, and **5 integrated native/Core/backend checks** with disposable storage. The integrated check exercised the actual Core settings resolver, request/body templates and confirmation enforcement, including cancel preserving state and confirmed reset reaching the backend. Evidence: `/tmp/stopwatch-third-pass-evidence.json`, `/tmp/stopwatch-browser-workflow-results.json`, and `/tmp/stopwatch-native-real-results.json`. All isolated app processes were stopped.

### Creator runtime evidence and final checks

The creator now has a reviewed `stopwatch-v1` backend adapter that starts isolated disposable state, executes nine real HTTP workflow/isolation checks and binds fresh evidence to the private source snapshot and reviewed harness. Missing adapters remain unverified; unknown or modified adapters fail. See [creator-validation-audit.md](creator-validation-audit.md) and [creator-runtime-validation.md](creator-runtime-validation.md) for retained evidence and exact boundaries.

The whole core suite passed **527 tests in 47 files** and the dashboard suite passed **221 tests in 50 files**. Final Launchpad glyph changes additionally passed its **10 focused tests**, typecheck and lint. Core and final dashboard production builds passed; targeted download lint/typecheck and `git diff --check` passed. Core and dashboard were deployed through the existing supervisor; the terminal daemon recovered automatically and all three returned healthy with zero consecutive failures. The updated Stopwatch container also returned healthy.

### Follow-up priorities

1. Extend real workflow validation to other generated apps with app-specific disposable data and observable outcomes; the Stopwatch adapter is deliberately narrow.
2. Make native action availability reflect backend capability flags, and provide direct native input forms. Stopwatch naming currently uses the existing Assistant handoff; its real Core input template was tested, but no paid model call was made. Invalid native Lap requests currently produce a clear backend error; the standalone interface disables the button.
3. Improve Launchpad grouping and labels for infrastructure services and similarly named instances. The current app list includes these as distinct launchable services; it does not deduplicate different running instances.
4. Continue real device/accessibility review and retention management for validation snapshots. The checks do not establish complete accessibility compliance or an OS security sandbox.

Live authenticated reads establish production connectivity, not a production destructive-action test. The isolated integrated Stopwatch workflow bypasses authentication ingress. Pending creator research/design documentation still needs its own review before using those old workspaces for a new creator publication.

## Fourth pass — intent-based creation and complex charts, 6 September 2026

The additional creation request was exercised against the configured OpenAI model and the actual native renderer. The existing Recharts/shadcn integration now supplies consistent line, area and grouped bar charts; no additional chart dependency was needed. The intent catalog includes analytical comparison, and the hashed creator instruction pack includes schema-validated chart examples and an explicit chart contract.

Charts now preserve negative values and genuine zeroes, display missing measurements as gaps, label series/axes/units, and provide a keyboard-operable **View data** table. Percent charts consistently consume fractions. Compact layouts retain readable chart height; truncated observations are labeled. Legacy series IDs remain compatible through safe internal plotting keys. Empty and all-missing datasets have distinct messages. Twelve rendered checks covered the three chart variants at 390, 480, 768 and 1440 px, including exact values, gaps, keyboard behavior and overflow.

### What the real model test established

The configured model produced **Operations Atlas**, a three-screen app with line, area and grouped bar charts, tables, summary metrics and twelve months of explicitly synthetic observations. Its raw response is retained. Two unused empty currency metadata fields caused local schema rejection; a narrow repair now removes only that invalid non-currency metadata and revalidates the entire blueprint. An offline replay through the actual AI SDK verified this repair without another provider request. No numerical data was altered.

The final native browser run passed across all three screens and four widths, including actual plotted marks and exact accessible table values. This establishes native rendering and fixture interaction, not a generated backend. The model's regional plan totals 18,600 while its December plan is 19,200, and its overview adjustment is −120 while December's adjustment is zero. Different scopes could explain these numbers, but the generated interface does not explain them. The demo remains unpublished. Creator guidance now requires traceable periods, units, formulas and reconciled totals; automated semantic validation remains future work.

The probe also found and fixed provider routing that ignored the selected model, encrypted-secret access, and OpenAI schema compatibility. Actual full code generation could not proceed because the installed Claude CLI lacks an active login. Talome now detects this before starting a terminal and displays an actionable error. The configured provider/model was not changed.

### Creation flow corrections

Build now prepares a private draft and publishes only after completion validation. Metadata-only scaffolds cannot pass as completed apps. Original environment requirements, sources and instruction-pack provenance survive first publication; validation claims are regenerated. Failed CLI exits remain failures even when they print output.

The Assistant retains the blueprint and prepared workspace when execution fails, displays the error beside Build, and retries that workspace. It no longer turns build/completion errors into automatic additional paid AI requests. A rendered isolated check verified the 503 error, visible retry, one preparation request, reuse of the same workspace, terminal/completion handoff and **View App** result. Its API and terminal responses were fixtures; no model or production app action was invoked.

Final review also corrected the lifecycle instructions: generated tasks, `CLAUDE.md` and the instruction pack now require local testing, completion and independent Talome publication before installation through the app details flow. They no longer ask an unpublished app to install itself. Switching conversations or replacing/dismissing a blueprint invalidates pending Build requests, preventing late terminal callbacks and additional execution after cancellation. Seven focused hook tests and a rendered delayed-response/conversation-switch check passed.

### Evidence and remaining work

- [Actual model output, attempt history and repair provenance](/tmp/talome-review-fourth/creation-path-review.json).
- [Final Operations Atlas native browser report](/Users/tomas/.talome/creator-validation/native-iDiiNN/.talome-creator/validation/native-browser/8bddcd56-4d0e-42a2-ac04-392cf6747eac/report.json), with adjacent screenshots.
- [Additional complex-chart fixture report](/Users/tomas/.talome/creator-validation/native-LL8ycM/.talome-creator/validation/native-browser/ebd77a82-b05e-49c2-a14d-25fd286a2c8e/report.json), covering signed/zero/missing data, limited series and legacy IDs.
- [Rendered creation handoff and retry evidence](/tmp/talome-review-fourth/creator-handoff.json), [chart renderer review](/tmp/talome-review-fourth/chart-renderer-review.md), and [AI SDK repair replay](/tmp/talome-review-fourth/model-normalization-replay.json).

The final integrated core suite passed **560 tests across 51 files**, dashboard **234 tests across 53 files**, and both production builds passed. Both native chart reports were rerun against that final dashboard build. Targeted frontend lint/typecheck and `git diff --check` passed; isolated browser/server processes were cleaned up.

Core and dashboard were deployed through the existing supervisor. At **2026-09-06 00:40:12 UTC**, core PID 20966, dashboard PID 20959 and terminal PID 21049 were healthy with zero consecutive failures. Core reported database/Docker OK, dashboard returned HTTP 200 and terminal health returned OK. Authenticated desktop reload retained the Settings/Media windows, showed **zero active and two completed downloads**, and displayed a current CPU sample of 17.4%. [Final deployment and QA evidence](/tmp/talome-review-fourth/deployment-final.json). No generated demo was installed and no production application action or data reset was used for fourth-pass testing.

Next priorities are a complete scaffold-to-installed-app run after Claude CLI login, executable semantic checks for generated analytics, and real backend adapters beyond Stopwatch. The visual and functional follow-ups listed in the third pass remain applicable. This pass does not establish complete accessibility compliance or certify generated analytical correctness.
