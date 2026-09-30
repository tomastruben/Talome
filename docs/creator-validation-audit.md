# Creator validation audit — 2026-09-05

## Findings and changes

1. **Completion could report success without a runnable app.** The interactive `/api/apps/create/complete` route checked only file existence and design Markdown, bypassing the headless validator. An empty workspace even returned `ok: true`. Both paths now use one generated-file validator. Completion requires a nonempty Compose service definition and successful `docker compose config --quiet`; failed checks block publication and return details.
2. **Native generated actions could disappear on completion.** Publishing selected the original blueprint AppSpec even when the generated `talome-app.json` contained newer surfaces/actions. Completion now validates that artifact, checks its app identity, and passes the actual contract into publishing. The resulting creator metadata retains validation results instead of an empty array. Headless completion returns the updated blueprint, and draft publishing re-reads the generated artifact so even callers holding a stale blueprint preserve the new actions. Staged creations must supply a native contract; the legacy fallback applies only to genuinely older workspaces.
3. **Validation assumed Next.js root entry points.** Actual Stopwatch and Strategy Intelligence are Python apps with native Talome surfaces. The common validator accepts these, finds nested TypeScript UI packages, and invokes each applicable package's installed compiler with `--noEmit`. It does not install dependencies or start containers. Each subprocess has a 30-second timeout.
4. **Ambiguous native action references were accepted.** AppSpec validation now rejects duplicate surface IDs, duplicate block IDs within a surface, duplicate action input IDs, and row actions bound to undeclared inputs. Existing approved native specs remain compatible.
5. **Creation unnecessarily required an API key after interactive planning.** A complete prebuilt blueprint now reaches workspace preparation without an Anthropic API key. AI blueprint generation still requires its configured key.
6. **Launching a creator session broke on paths with spaces.** Workspace and prompt paths are shell-quoted; prompt files use random names and mode `0600`. A shell-level regression test proves spaces, apostrophes, and literal command-substitution text survive unchanged.
7. **Headless errors were counted as success if they printed output.** Execution status now respects the runner's success flag.

The root task also added the versioned design-pattern catalog and intent lookup; the creator route exposes it at `/api/apps/design-patterns` under existing authentication.

## Evidence and verification

- Inspected the five generated workspaces in `~/.talome/generated-apps` without modifying them. Strategy Intelligence's blueprint has no native AppSpec, while its generated artifact contains five actions and five surfaces. Stopwatch's generated artifact contains six actions and one surface.
- Ran the real new validator on Stopwatch and Strategy Intelligence: Docker Compose configuration and native contracts passed for both. This was read-only configuration validation; no containers were started or rebuilt.
- Parsed the five installed native AppSpecs (Budget Compass, Server Weather, Stopwatch, Strategy Intelligence, Weather Guard) using the stronger schema: all passed.
- Core suite with a disposable test secret: 39 files, 468 tests passed. Final focused creator/contract/shell regression pass: 5 files, 22 tests passed. Core TypeScript check passed.
- An earlier accidentally broad test invocation lacked `TALOME_SECRET`; its 13 auth/crypto/invitation failures disappeared with the test-only secret. No production secret was read or changed.

## First-pass limits (see second-pass changes below)

- Compose and type checks establish structural validity, not real workflow success. Rendered workflow evidence is still supplied through the existing Markdown report. A future isolated browser runner should execute declared actions, assert resulting state, capture compact/dark-mode evidence, and record failures independently.
- Stopwatch's research/design validation report remains pending in its existing workspace. No report was rewritten to manufacture a pass.
- Older Weather Guard and Server Weather native specs expose generic service management. Stopwatch's installed native session source is static. These are product-capability gaps beyond schema correctness and need application-specific runtime work.
- Interactive completion and draft publishing now preserve generated artifacts, including headless callers. Low-level direct `createUserApp` callers still select their supplied blueprint contract; the store publisher could eventually unify artifact selection for those entry points as well.
- The new checks do not run generated test suites, install packages, mutate application data, or prove accessibility, uptime, or visual quality. Live rebuild/restart and browser QA are coordinated by the root task.

## Second pass — independent native browser validation, 2026-09-06

The earlier recommendation for a future isolated browser runner is now implemented. Completion and native publication run `scripts/validate-native-app.mjs` against the real, built dashboard/native renderer in a separate local standalone process and headless Chrome context. They no longer rely on a Markdown report to establish native rendering or interaction behavior. Markdown research/design review remains an additional existing gate.

The runner loads the exact native contract, supplies deterministic source responses, and intercepts all browser API/action requests and WebSockets. Requests outside the isolated origin are blocked; an explicit external fetch probe verifies that block. It checks every declared surface and block at 390, 768 and 1440 px, dark-theme activation, nonblank content, horizontal overflow, pointer/keyboard surface selection, and runtime errors. Applicable tests exercise exact action POST IDs and payloads, disabled pending controls, completion feedback plus source refresh, Assistant prompt handoff, error/retry recovery and empty data. A synthetic destructive action test verifies that confirmation appears and Cancel issues no destructive request. The runner never invokes a real application action or a paid model.

Every browser result declares `scope: native-renderer-fixture`. In this second pass, a separate `app-runtime` check was always `skipped`, explicitly identifying real service data, external UI and real action side effects as unverified. The third pass below adds a supported backend adapter. Browser request interception remains distinct from an operating-system network sandbox or proof of arbitrary backend workflows. Chrome, Playwright and a built standalone dashboard must be available; missing tooling, browser failures and timeouts fail the native gate with an actionable error.

### Publication and evidence integrity

- Generated source is copied into a private validation snapshot first. Validation and publishing use that same snapshot; later changes to the editable workspace cannot alter the published source.
- Source symlinks are rejected. Validation and publication share exclusions for dependency/build/cache directories. Root `creator.json` is reserved for server-authored metadata and excluded from both source copying and source hashing; nested files of that name remain ordinary source.
- The native contract and publication metadata overrides, including the next database revision, are resolved in the snapshot before validation. Store publication preserves the exact tested spec bytes and rejects concurrent revision changes or unrelated destination files instead of silently changing the validated output or deleting user data.
- Reports bind source paths/bytes and the exact AppSpec with SHA-256, the dashboard build ID and compiled renderer artifacts, and the harness source. Screenshots are checked as PNG files and individually hashed. Source/renderer changes during a run fail validation.
- A caller cannot bypass fresh validation by setting `generatedWithClaudeCode: false` or removing workspace metadata. Prepared native-only drafts use a private minimal native-contract snapshot. Low-level store callers cannot publish file-backed workspaces without the trusted snapshot parameter, and caller-supplied validation claims are discarded.
- Browser input is passed through stdin by a bounded subprocess runner. Its environment excludes credentials and `NODE_OPTIONS`; its 120-second deadline and output limit terminate the process group, including orphaned descendants. Tests cover literal input, missing tools, process crashes, timeouts, output limits and descendant cleanup.

### Final evidence

All four final runs passed against dashboard build `KpuD76FffGRhAqO_rAAxX` (compiled renderer SHA-256 prefix `c60f92338606`). Reports and their neighboring screenshot files are retained privately:

- [Generated Stopwatch contract: service-action fixture, refresh and error recovery](/Users/tomas/.talome/creator-validation/run-jzpsne/.talome-creator/validation/native-browser/11e8b0ae-bd22-4b82-8aff-e2acbd96bc7f/report.json).
- [Installed Stopwatch wrapper: static data and Assistant handoff](/Users/tomas/.talome/creator-validation/run-cJq3st/.talome-creator/validation/native-browser/eba6747b-d7c1-4c30-bad2-76361b098cc3/report.json). Its static sources correctly mark alternate data/error states inapplicable; this does not establish a live stopwatch workflow.
- [Updated Weather Guard: three native surfaces, Assistant handoff, error/retry recovery](/Users/tomas/.talome/creator-validation/run-mP0Vdz/.talome-creator/validation/native-browser/dd377d2f-a13f-4d46-b5ac-d18001955b64/report.json). The root task separately connected its real native data sources; this runner's data remains explicitly synthetic.
- [Synthetic boundary fixture: action feedback, destructive confirmation/Cancel and blocked external request](/Users/tomas/.talome/creator-validation/native-jh6i9K/.talome-creator/validation/native-browser/d8ede898-fa64-4358-ab3d-aaeac1d1a5a8/report.json).

Targeted creator/contract tests: 35 passed across 7 files. Root's final whole-core check: 511 tests across 45 files passed, TypeScript/build passed, followed by the supervised core restart. The root task owns final live health and dashboard validation. No generated service, installed application data, production secret, or existing design report was changed by these browser runs.

Remaining limitations: arbitrary generated backend workflows still need their own isolated executable tests; this runner does not establish contrast ratios, complete accessibility compliance or visual design quality. Validation snapshots and evidence are retained under `~/.talome/creator-validation`; automatic retention cleanup is not implemented. Existing generated workspaces with pending research/design reports still require that work before completion.

## Third pass — supported real backend workflow validation, 2026-09-06

Completion now replaces the browser runner's placeholder with one independently executed `app-runtime` result. The initial supported declaration is `talome-runtime-probe.json` containing exactly `{ "version": 1, "adapter": "stopwatch-v1" }`. Missing declarations remain explicitly unverified. Unknown adapters, extra command fields, missing or modified backend files, missing Python, crashes, timeouts, failed assertions, missing workflow evidence, and changed source/runner hashes cannot produce a passing runtime result. Declared adapter failures block publication.

Core accepts only the exact reviewed `apps/stopwatch/server.py` and `stopwatch.py` bytes. The trusted runner receives them through stdin, writes only those two source files into a new private directory, and starts Python with `-I -B`, a private HOME/CWD/session path, and `127.0.0.1` on an ephemeral port. It copies no workspace dependencies or `.env` files. A Python audit guard denies outbound connections, DNS, child commands and file opens for writes outside disposable state. The outer subprocess group is bounded to 30 seconds with an output limit. Normal completion and failure stop the service and remove its temporary data; force termination may leave a private temporary directory but stops descendants.

Real HTTP requests check new empty state, invalid lap/label/reset rejection, start, rename, advancing elapsed time, lap creation, pause stability, preserved duration/label/laps across restart, safe paused recovery of a running session, and confirmed reset persistence. Reset affects only the new disposable session. The parent requires all nine workflow/isolation markers and binds the report to the full publishable snapshot, native contract, reviewed backend bytes and runner hash, then checks those bindings again after execution. Generated reports are never accepted as evidence.

### Fresh retained evidence

- [Actual Stopwatch runtime report](/Users/tomas/.talome/creator-validation/run-nOKbHK/.talome-creator/validation/app-runtime/103c5587-c245-4698-a11e-e4046e6bac8b/report.json): **passed**, all nine checks, generated at `2026-09-05T23:22:44.978Z` (September 6 local time).
- [Exact reviewed app snapshot](/Users/tomas/.talome/creator-validation/run-nOKbHK/generated-app/talome-app.json): 16 source files; source SHA-256 `82ea2fefd943df7794c5e2149b8dd23da5bb6718d5cb5d1ba64eaa090b438052`; reviewed adapter SHA-256 `ba2f2f69521df031a45d7c7d13ad447d0b767f3801beab96c3ee0c7167229f36`.
- Focused runtime/completion/browser-process/browser-evidence tests: **34 passed in four files**. This includes a real HTTP probe, a real missing-Python runner failure despite a forged workspace report, stale/missing/modified sources, unsupported declarations, required markers, and unique `app-runtime` status. Core TypeScript passed. Root's final whole-core check: **527 tests in 47 files passed**, followed by successful core and dashboard builds.
- The fresh probe completed in approximately 2.3 seconds. Its service processes exited and its disposable session directory was removed by the runner; a subsequent process scan found no remaining probe Python service. No production state, service, setting, or deployment was changed by this validation.

This report proves only the reviewed backend's supported HTTP workflow with disposable state. It does **not** establish browser-to-backend wiring, Docker deployment, production connectivity, external UI behavior, or arbitrary generated backend correctness. The native fixture report and this HTTP report are separate evidence and must not be combined into a claim of integrated UI execution. The sibling app task separately produced real native/Core bridge evidence; that evidence has its own scope. These controls are application-level trusted orchestration around reviewed code, not a hardened OS boundary against malicious same-user processes. See [runtime adapter details](creator-runtime-validation.md).

## Fourth pass — complex charts and first publication, 2026-09-06

Native browser evidence now requires **390, 480, 768 and 1440 px**. For every time-series block on each surface, the runner checks a real SVG with finite geometry, applicable plotted series/marks, series labels and a keyboard-opened numeric table. It reconciles displayed table cells against the fixture or static source, including zero, negative and missing values, and honors each block's observation limit. Shared response paths are composed rather than overwritten. Empty charts must show an explicit empty state. Earlier three-width reports are stale for the current gate.

The native renderer uses the existing Recharts 3.8.0/shadcn stack for line, area and grouped bars. The v2 intent catalog adds analytical comparison; a hashed chart contract supplies two schema-validated app-API examples. Its numerical conventions include fraction-based percentages, explicit units, visible missing values and provenance. The generation prompt now requires period/scope/formula reconciliation. These instructions are guidance; analytical correctness is not yet an automated publication gate.

### Actual generation, with limits preserved

Three bounded requests used the user's configured OpenAI model. The first hit an incompatible strict JSON schema before output. The second probe crashed because an imported background job queried a table missing from the probe's minimal disposable database; that is a test-harness failure with an unknown model outcome. The third returned a complete Operations Atlas blueprint, whose local schema rejected two unused empty currency fields. Raw output and failure evidence remain unchanged.

Production normalization now removes only unused empty currency metadata on non-currency table columns, then reparses the complete schema. The captured response passed an offline replay through the installed AI SDK with one repair callback and zero provider requests. The normalized app retained all original numbers/actions. It passed **30 native browser checks** across three surfaces/four widths. A separate handcrafted three-surface/four-chart fixture covered live-source fixtures, signed/zero/missing values, truncated series, all-missing data and unusual legacy series IDs. Neither probe published an app or ran a generated service.

Human review found unexplained regional/monthly plan totals (18,600 versus 19,200) and adjustment scopes (−120 versus zero). These remain recorded, not silently corrected. Passing schema/renderer checks does not certify the generated analytical meaning. Full scaffold generation remains untested because Claude CLI subscription login is inactive; readiness now rejects execution explicitly before terminal startup. Provider selection and secret loading are shared with Assistant; blueprint generation no longer requires an unrelated Anthropic credential.

### Publication and retry lifecycle

Scaffold-enabled creation now returns a private pending draft, including when a caller requested immediate saving. Metadata-only generated directories fail the implementation gate. Completion can make the first publication directly from private workspace metadata, retaining source/environment/instruction provenance while using fresh source, Compose, native and applicable design/runtime validation. Non-scaffold publication remains separately validated. A nonzero Claude process exit cannot be reported successful merely because stdout exists.

Assistant execution errors are visible and retain the blueprint/workspace. Retry reuses the same preparation, and build/completion failures do not automatically trigger another paid Assistant request. The rendered handoff test uses API/terminal fixtures and closed backend port 9; it proves client request sequencing and visible state, not successful CLI generation or backend publication. Backend regression tests separately cover initial pending drafts, publication without an installed seed, provenance preservation, forged validation claims and metadata-only rejection.

All generated lifecycle instructions now defer installation/startup until after publication through app details; local tests cannot be described as a running published service. A real disposable-workspace regression verifies the task, resumed `CLAUDE.md` and copied instruction pack agree. Frontend pending requests are scoped to the blueprint and conversation: changing either cancels the client request and discards late callbacks/errors. Seven focused tests cover preparation/execution races and unmount; a rendered delayed-preparation test confirms switching conversations prevents the execution request entirely.

### Retained fourth-pass evidence

- [Model attempts, raw output and provenance](/tmp/talome-review-fourth/creation-path-review.json); [actual SDK repair replay](/tmp/talome-review-fourth/model-normalization-replay.json).
- [Final actual-model native report](/Users/tomas/.talome/creator-validation/native-iDiiNN/.talome-creator/validation/native-browser/8bddcd56-4d0e-42a2-ac04-392cf6747eac/report.json).
- [Final complex fixture native report](/Users/tomas/.talome/creator-validation/native-LL8ycM/.talome-creator/validation/native-browser/ebd77a82-b05e-49c2-a14d-25fd286a2c8e/report.json).
- [Independent chart renderer review](/tmp/talome-review-fourth/chart-renderer-review.md); [creation handoff/retry review](/tmp/talome-review-fourth/creator-handoff-review.md).

Whole-suite/build/deployment outcomes and remaining priorities are recorded in [the improvement audit](talome-improvement-audit.md#fourth-pass--intent-based-creation-and-complex-charts-6-september-2026). All generated analytics observations are synthetic; no new chart app was installed, existing app data reset, or AI provider preference changed.
