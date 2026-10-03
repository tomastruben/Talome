# Talome app creation audit — 3 October 2026

## Decision

Talome already has structured specifications and desktop integration. Its main gap is the assurance connecting the accepted user workflow, generated implementation, installed service, and native interface. A generated app can pass its publication checks and appear **Running**, while its native interface cannot access its backend.

Prioritize reliable installation-to-native API wiring and real workflow verification before adding more generation prompts or visual effects. Strengthen design consistency through shared renderer components and a versioned desktop contract.

## Scope and evidence

Audited the current deployed revision `44cf0edd` using `/Volumes/Media Hub/dev/Talome-wt/combine`, not the older default checkout at `/Volumes/Media Hub/dev/Talome`. The earlier checkout has an older creator architecture and unrelated local changes. No application code, installed apps, or settings were changed during this audit.

Evidence includes current source, generated creator metadata and native contracts, the live Tailscale desktop/App Store/LiteMol interface, and focused automated tests. This is a targeted product and implementation audit, not a full accessibility certification or an end-to-end test of a newly generated app.

Screenshots captured during this audit:

- [App Store entry](/Users/tomas/.codex/visualizations/2026/10/02/01a0fe63-d25f-74e3-bc6a-ad506062d97a/creator-audit/01-store-entry.png)
- [My Apps](/Users/tomas/.codex/visualizations/2026/10/02/01a0fe63-d25f-74e3-bc6a-ad506062d97a/creator-audit/02-my-apps.png)
- [LiteMol detail](/Users/tomas/.codex/visualizations/2026/10/02/01a0fe63-d25f-74e3-bc6a-ad506062d97a/creator-audit/03-app-detail.png)
- [LiteMol native data failure](/Users/tomas/.codex/visualizations/2026/10/02/01a0fe63-d25f-74e3-bc6a-ad506062d97a/creator-audit/04-native-app.png)

## How creation currently works

1. **Intent and planning.** Create app in the App Store opens the Assistant with a creation prompt. The assistant assembles blueprint sections for identity, research, design, services, environment, scaffold, native experience, and acceptance criteria. The old `/dashboard/apps/create` route is not the current entry point.
2. **Structured blueprint.** Zod schemas describe use cases, workflows, screens, visual direction, Docker services, dependencies, and the native AppSpec. Legacy paths can supply default experience plans/AppSpecs, so structural completeness does not necessarily establish useful product completeness.
3. **Generation workspace.** Talome writes the blueprint, instruction pack, source candidates, project references, and research/screen-spec/validation artifact locations. A CLI coding agent generates the application in `generated-app`.
4. **Independent completion checks.** Completion snapshots the source privately, validates actual Compose configuration, validates the native contract and action/data references, runs applicable TypeScript compilers, and invokes a browser harness against the real native renderer with fixture responses. Reports are bound to the source/AppSpec/renderer evidence.
5. **Publication.** Failed required checks block publication. The validated snapshot is copied into My Apps, with metadata and an approved native contract. Installation is a separate lifecycle step.
6. **Runtime presentation.** Talome renders declarative native surfaces with its own components. Desktop windows provide shared controls and headers; embedded multi-surface apps use sidebar navigation. A generated service may also have an original web interface.

The source snapshot boundary, native schema, and independently generated browser evidence are valuable foundations. Preserve them while broadening what is tested.

Key sources:

- [Blueprint contracts](/Volumes/Media Hub/dev/Talome-wt/combine/apps/core/src/creator/contracts.ts)
- [Orchestrator](/Volumes/Media Hub/dev/Talome-wt/combine/apps/core/src/creator/orchestrator.ts)
- [Completion checks](/Volumes/Media Hub/dev/Talome-wt/combine/apps/core/src/creator/completion-validation.ts)
- [Native runtime](/Volumes/Media Hub/dev/Talome-wt/combine/apps/dashboard/src/components/native-app/native-app-runtime.tsx)

## Observed flow health

| Step | Health | Evidence and implication |
|---|---|---|
| 1. Find creation | Needs improvement | Creation is available through a small plus in the App Store header. A visible Create app label in My Apps would make a core capability easier to discover. |
| 2. Review specification | Partial | Structured planning exists, but the app detail page does not expose a concise accepted workflow, native/external boundary, or verification summary. Users have little basis to assess what was delivered. |
| 3. Find a creation | Working with gaps | My Apps shows generated app cards and running/stopped state. Lifecycle and verification states should be distinguished from container state. |
| 4. Open in desktop | Working | LiteMol opens as an independent native desktop window with shared controls and header actions. Desktop mode is already implemented. |
| 5. Perform the main job | Fails in tested sample | LiteMol shows unavailable health data despite a healthy running container. Its native view contains status, curated demos, and controls; the actual interactive 3D viewer belongs to the original interface. That boundary should be explicit at specification/review time. |
| 6. Understand/recover from failure | Needs improvement | The native view shows `viewer-health: Failed to resolve native app data`. Retry cannot repair a missing connection. The message should explain the integration problem and offer the appropriate recovery action. |

## Ranked improvements

### P0 — Wire generated services into native data and actions

**Verified failure:** LiteMol is Running in My Apps. `check_service_health` reports healthy. Its native UI reports unavailable data. A read-only `app_api_call` to `/api/health` returns: `No configuration found for 'litemol-protein-viewer'. Set litemol-protein-viewer_url in Settings.`

The native AppSpec declares an app-api health source and viewer actions. The universal app connection resolver falls back to an `<appId>_url` setting for custom apps. This connection is absent for the tested installed creation.

Introduce a typed service binding: service identity, container port, API base path, authentication reference, and browser opening strategy. Resolve the internal API connection server-side from the installed app record. Refresh it after port changes/reinstall. Keep credentials and Docker access server-side. An arbitrary URL must not become an unrestricted proxy.

Acceptance test: install an isolated generated service without manually adding a URL setting; read its real health data through the native route; run one action; verify changed state through a subsequent read. Repeat after changing the host port. Test failure and recovery without misleading Running/Ready wording.

Sources: [Connection resolver](/Volumes/Media Hub/dev/Talome-wt/combine/apps/core/src/ai/tools/universal-tools.ts), [AppSpec execution](/Volumes/Media Hub/dev/Talome-wt/combine/apps/core/src/app-specs/service.ts).

### P0 — Update and strengthen the browser validation boundary

The current harness mounts a native route in an iframe, then requires an app-name heading and tab-role navigation. The current embedded renderer hides the standalone heading and uses sidebar items/compact navigation instead of tabs. This is a source-level mismatch corroborated by the live embedded DOM; a fresh full harness execution was not performed in this audit.

Test standalone rendering and the real desktop shell separately. Use semantic expectations appropriate to each presentation. In desktop tests, verify the window title, shared toolbar, surface navigation, resize behavior, primary action, overlay detachment, and assistant handoff. Include a known valid contract as a harness smoke test so shell changes cannot silently leave completion checks outdated.

Existing fixture tests establish renderer behavior, not real generated-service behavior. The runtime adapter currently supports the reviewed `stopwatch-v1` implementation; other apps can have runtime validation skipped. Keep separate evidence states for configuration, renderer fixtures, service behavior, and installed integration. Never imply an app is fully verified because a Markdown report is complete.

Sources: [Browser harness](/Volumes/Media Hub/dev/Talome-wt/combine/scripts/validate-native-app.mjs), [Runtime validation](/Volumes/Media Hub/dev/Talome-wt/combine/apps/core/src/creator/runtime-validation.ts).

### P1 — Make the design system executable and current

The instruction pack already covers semantic colors, typography, allowed components/icons, workflow states, dark mode, reduced motion, and charts. The reference snapshot pack contains only project rules, the Assistant page, blueprint draft review, and app detail page. It omits the actual theme tokens, native renderer, controls, search field, desktop toolbar, and sidebar components.

Add those source references, with a small curated example for a single-surface and multi-surface native app. Bind their versions/content hashes to the generation pack. Give the agent a concrete desktop composition contract rather than relying on prose and unrelated page examples.

Use the central native renderer to enforce common spacing, radii, controls, themes, icons, and motion. For generated original interfaces, provide a reusable starter package/template using the same tokens and primitives. A standalone interface needs its own validation; native-renderer screenshots do not verify it.

Add light mode to the release matrix. Current automated native browser checks cover four widths in dark mode, but do not cover light mode or the full desktop shell. Test iPad window sizes with ordinary control sizing, consistent with the user's preference; do not enlarge controls just because input is touch.

Source: [Instruction/reference pack](/Volumes/Media Hub/dev/Talome-wt/combine/apps/core/src/creator/instructions.ts).

### P1 — Connect the specification to the delivered task

Require each accepted primary use case to map to an actual AppSpec surface/action or an explicitly identified original-interface workflow. Reject a generic status/actions dashboard as fulfillment of a specialized interactive job unless the user accepted that scope.

For LiteMol, the native control surface and external 3D viewer are different experiences. Both can be valid, but the specification must explain which experience completes the user's task, how it opens, and how its state connects to native actions.

Cross-check IDs and mappings mechanically; validate visible success with a real workflow. Review should show purpose, main workflow, screen outline, storage/network needs, native/external boundary, and test status in plain language. Keep the detailed technical blueprint available as an expansion.

### P1 — Clarify lifecycle and repair

Use distinct states such as Draft, Generating, Needs repair, Ready to install, Installed, and Verified. Show a concise verification summary and last tested revision. Container Running remains a separate operational signal.

Expose Continue editing through the Assistant, with CLI tools as an optional advanced path. Preserve the previous working revision during a failed regeneration. Add a clear route to repair missing connections and failed workflows. The live app detail's original interface points to an HTTP host port while Talome is accessed through HTTPS/Tailscale; verify reachability and choose a supported consistent opening strategy rather than assuming direct host ports work remotely.

## Proposed creation contract

Extend the existing blueprint rather than introducing a parallel specification:

| Area | Required decisions |
|---|---|
| User task | Primary outcome, concrete acceptance workflow, success state |
| Presentation | Native, original interface, or hybrid; clear responsibility of each surface |
| Desktop | Shared shell/header, navigation, minimum useful window size, resize behavior, overlays and handoff |
| Data/actions | Service binding, endpoint contracts, authentication reference, permission scope, input/output schemas |
| Design | Versioned Talome tokens/components, dark/light support, density, reduced-motion behavior |
| Reliability | Loading/empty/error/recovery, persistence, restart behavior, upgrade/rollback |
| Evidence | Artifact revision, configuration checks, fixture checks, actual service checks, installed workflow checks |

The desktop shell owns window controls and common chrome. Generated apps specify their content and behavior; they should not recreate window controls or duplicate shell headers.

## Verification performed

- **Backend:** 8 focused creator suites, **78 tests passed**: creation, completion, design workflow/patterns, browser validation orchestration, publication boundary, runtime validation, and publication contract.
- **Frontend:** 7 focused suites, **31 tests passed**: blueprint building/review, desktop native navigation, native runtime/values/activity, and launcher integration.
- **Typechecks:** `pnpm exec tsc --noEmit` passed in both current core and dashboard apps.
- **Live:** navigated App Store → My Apps → LiteMol detail → native desktop window; captured the data failure; compared container health with a real read-only API request and confirmed the missing connection.

These passing unit/component checks do not certify newly generated apps. No new app was generated, no real application action was executed, and no light-mode/iPad/full browser-harness run was completed in this audit. The live failure is itself evidence that existing checks leave an integration gap.

## Recommended delivery order

1. Fix service binding and its install/read/action/read integration test; align the browser harness with current embedded navigation.
2. Add the desktop/design contract and current component reference pack; test dark/light and standalone/desktop presentation.
3. Add task-to-surface/action traceability and transparent verification states to the creation review and app detail.
4. Test three representative creations: a simple stateful utility, a data-driven CRUD app, and a specialized interactive viewer. Exercise persistence/restart and a failed-revision recovery, not only initial screenshots.

Completion means the accepted primary task succeeds through the installed app, in its intended presentation, with evidence tied to the shipped revision.


## Implementation follow-up — 3 October 2026

Implemented and deployed the first reliability/design-contract changes in the current combine checkout and running server:

- Personal creation API connections now resolve from the installed app and current running Compose container's published web port. Explicit URL/credentials remain authoritative. Multi-port manifests must select webPort; ambiguous, stopped, uninstalled and unrelated containers are rejected. No manual URL setting was added to repair LiteMol.
- Browser completion evidence now requires dark and light surfaces at four widths and standalone presentation. Embedded checks use the current sidebar/compact menu instead of obsolete headings/tabs. Screenshot counts and evidence requirements were strengthened.
- Generation now receives theme, button/search, desktop toolbar/sidebar and native renderer/block snapshots, with source hashes included in the instruction-pack version. A desktop contract requires task-to-surface/action mapping, native/external scope, ordinary iPad control sizes, service endpoints and honest verification scopes.

Verified a real isolated HTTP service with read → POST → read-back through the API executor, live LiteMol health (HTTP 200), a fresh two-surface browser fixture run with 16 dark/light screenshots, and the full source-bound browser validation entry point. The latter passed native rendering and explicitly skipped unsupported LiteMol runtime validation. Core and dashboard production builds passed. The Tailscale native page now displays **healthy**, without the previous unavailable-data error.

![Live LiteMol connection restored](/Users/tomas/.codex/visualizations/2026/10/02/01a0fe63-d25f-74e3-bc6a-ad506062d97a/creator-audit/05-native-app-connected.png)

The broader creation-review/lifecycle UI redesign and generic per-app runtime adapters remain roadmap items. These changes do not certify arbitrary generated original interfaces or claim that every generated app's primary workflow has been exercised.
