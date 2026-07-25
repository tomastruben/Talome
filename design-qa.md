# Budget Compass design QA

## Evidence

- Source visual truth: `/Users/tomas/.codex/generated_images/019f80dc-d9ab-7800-af22-3813cebe37ed/exec-f39bcea0-0412-4573-9728-c405f03fa724.png`
- Final production implementation: `/Users/tomas/.codex/visualizations/2026/07/20/019f80dc-d9ab-7800-af22-3813cebe37ed/talome-dark-audit/18-dark-overview-final-1586x992.png`
- Same-input comparison: `/Users/tomas/.codex/visualizations/2026/07/20/019f80dc-d9ab-7800-af22-3813cebe37ed/talome-dark-audit/19-dark-source-vs-final.png` (source left, implementation right)
- Final Categories state: `/Users/tomas/.codex/visualizations/2026/07/20/019f80dc-d9ab-7800-af22-3813cebe37ed/talome-dark-audit/14-dark-categories-final-1586x992.png`
- Final Activity/search/filter state: `/Users/tomas/.codex/visualizations/2026/07/20/019f80dc-d9ab-7800-af22-3813cebe37ed/talome-dark-audit/15-dark-activity-filtered-final-1586x992.png`
- Dark-mode failure evidence: `/Users/tomas/.codex/visualizations/2026/07/20/019f80dc-d9ab-7800-af22-3813cebe37ed/talome-dark-audit/01-dark-overview-before.png`
- Compact desktop-window evidence: `/Users/tomas/.codex/visualizations/2026/07/20/019f80dc-d9ab-7800-af22-3813cebe37ed/talome-dark-audit/16-dark-overview-open-final.png`

## Normalization and state

- Source and final implementation are both 1586 × 992 pixels at a 1586 × 992 CSS viewport and normal browser density. No rescaling was used in the final side-by-side comparison.
- Route: `/dashboard/desktop`; Budget Compass maximized in the Talome desktop window.
- Theme: the real iframe document has the `.dark` class active.
- State: Overview selected, July 2026 self-hosted starter data. Dynamic day-remaining and projection values differ from the concept because the implementation uses the live current date.
- A natural 1212 × 912 desktop window was also inspected. At 860 px the Talome shell intentionally switches away from Desktop to the standard dashboard, so that redirect is the supported lower-breakpoint behavior rather than an untested embedded layout.

## Full-view comparison

The final source/implementation comparison was opened as one combined image. The implementation preserves the selected concept's dark Talome desktop chrome, large app identity, three-surface navigation, left-in-plan gauge, labeled income-to-category money flow, actual/plan/projection pace chart, high-priority category rail with large HugeIcons, recent activity, and contextual Talome insight. The compacted production layout now keeps the Talome insight and its action within the matched viewport.

## Focused review

Separate crops were not needed: at 3172 × 992 the combined comparison keeps the hero, radial gauge, Sankey labels, pace lines, right rail, and insight copy legible at native height. Categories and Activity were captured separately because they are distinct interactive states rather than details of the Overview comparison.

## Required fidelity surfaces

- **Fonts and typography:** Geist hierarchy, quiet two-weight treatment, tabular financial values, labels, and wrapping remain coherent in dark mode. No clipping or truncation affects primary values.
- **Spacing and layout rhythm:** card tracks, four-pixel gap rhythm, outer alignment, and the right rail follow the concept. The production version is intentionally a little more compact so the assistant insight remains visible in-window.
- **Colors and visual tokens:** background, card, border, muted text, healthy green, and warning amber resolve from Talome semantic tokens. Browser inspection found no invalid space-bearing chart custom properties and no black-on-black primary marks.
- **Image and icon fidelity:** the implementation uses real HugeIcons and the shared Talome app-icon container; no emoji, placeholder art, handcrafted SVG, or Wi-Fi metaphor is used. The shared icon container is an acceptable Talome-system adaptation of the concept's freestanding jar.
- **Copy and content:** private/self-hosted positioning, plan language, money-flow explanation, estimate labeling, starter-data disclosure, and Review with Talome action are present and task-specific.

## Findings and comparison history

1. **P1 — hero value clipped at the card edge.** Fixed in the earlier iteration by preserving a minimum text column and moving the value before the gauge. Final evidence: `18-dark-overview-final-1586x992.png`.
2. **P2 — radial and Sankey paints rendered black on black in dark mode.** Root cause was direct interpolation of labels containing spaces into CSS custom-property and SVG paint identifiers. Fixed with centralized CSS-safe EvilCharts keys used by styles, gradients, links, legends, tooltips, and glow filters. Final browser probe found zero invalid keys and resolved green/amber stop colors.
3. **P2 — money-flow nodes were visible but unlabeled.** Fixed the EvilSankey `NodeLabel` default, placed source labels before source nodes, and kept target labels beside target nodes. Final browser probe found Income, Retained, and all category labels in the production SVG.
4. **P2 — the assistant insight fell below the matched viewport.** Fixed by tightening the top-card and pace-chart vertical rhythm while preserving the chart and three summary values. Final evidence shows the insight and Review with Talome action in the 1586 × 992 viewport.
5. **P2 — Categories and Activity had not been rechecked in the real dark production bundle.** Fixed by exercising both tabs, selecting Expenses, and searching for `rent`; only Starter rent remained and the state stayed readable.
6. **P0 — none observed.**

No actionable P0/P1/P2 findings remain. Minor concept-to-system differences, including the shared app-icon container and reduced Sankey detail density, are accepted Talome adaptations.

## Functional and engineering verification

- Dashboard full suite: 30 files, 121 tests passed.
- Core full suite: 32 files, 426 tests passed with an isolated test-only `TALOME_SECRET`.
- Final targeted dark/runtime regression: 2 files, 6 tests passed after the last layout change.
- Dashboard and core TypeScript checks passed; targeted ESLint and `git diff --check` passed.
- The final production Next.js standalone build completed successfully and the supervised dashboard restarted healthy on port 3000.
- Browser console after the final Overview, Categories, and Activity flow: no warnings or errors.
- Primary interactions tested: Overview, Categories, Activity, Expenses filter, transaction search, responsive desktop-window breakpoint, and return to Overview.

## Left-in-plan annotation follow-up — 22 July 2026

- Source visual truth: `/Users/tomas/.codex/visualizations/2026/07/20/019f80dc-d9ab-7800-af22-3813cebe37ed/left-plan-card-audit/01-before.png`
- Implementation target: the rebuilt `LeftInPlanCard` in `apps/dashboard/src/components/native-app/budget-overview-block.tsx`.
- Intended comparison viewport/state: 1212 × 912 CSS pixels, normal browser density, `/dashboard/desktop`, Budget Compass Overview, dark mode, July 2026 starter data.
- Source pixels: 1212 × 912. No density normalization was needed for the source capture.
- Implementation pixels: unavailable in the current QA pass because the selected in-app browser disconnected during the production reload and remained unavailable after the documented recovery flow.
- Full-view and focused-region comparison: blocked. A browser-rendered post-change capture could not be opened beside the source capture, so typography, spacing, color-token resolution, icon fidelity, and final wrapping are not passed from code inspection alone.
- Implemented change: the card now leads with a semantic `Available to spend` value, explains the daily allowance and days remaining in one sentence, replaces nested mini-cards with a quieter Spent/Plan comparison, anchors the pace badge in the header, and labels the radial metric as `plan used`.
- Engineering evidence: targeted runtime/dark-mode tests passed (2 files, 6 tests); full dashboard suite passed (30 files, 121 tests); targeted ESLint, TypeScript, production build, and `git diff --check` passed; the supervised production server restarted on port 3000.
- Interaction and console evidence for this follow-up: unavailable for the same in-app-browser blocker. Earlier full-screen QA remains valid for the unchanged app shell, tabs, charts, and dark-mode token fixes, but it does not substitute for a current capture of this edited card.
- Required next QA step: reconnect the annotated in-app browser, capture the Overview at 1212 × 912, exercise Categories → Overview, check console warnings/errors, place the before and after captures in one comparison image, and resolve any P0/P1/P2 visual finding before changing this result to passed.

final result: blocked
