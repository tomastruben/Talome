# Design and Workflow Validation

A build or typecheck is necessary but not sufficient.

Talome's completion endpoint independently validates the actual `generated-app/docker-compose.yml` (or `.yaml`) with `docker compose config --quiet`, validates `generated-app/talome-app.json` and all its action/data references, and runs the installed TypeScript compiler for each root or nested package that has a `tsconfig.json`. Install each TypeScript package's declared dependencies before completion. Python and service-only packages do not need a TypeScript entry point. A missing or invalid compose file, invalid native contract, or failed typecheck blocks publication and is returned as an actionable validation result.

Keep the generated `talome-app.json` current when you add or change actions; it is the contract that completion publishes, including assistant-exposed actions. Use unique surface IDs, unique block IDs within each surface, and unique input IDs within each action. Row actions must bind inputs declared by their target action.

These automated checks establish configuration and contract validity. They do not replace the rendered workflow and accessibility checks below, and a completed Markdown report alone does not prove an app works.

Native completion and publication also run an independent browser check against the real Talome renderer with isolated data/action fixtures. It checks every declared surface at phone 390 px, compact desktop 480 px, tablet 768 px and desktop 1440 px, dark and light modes, embedded desktop sidebar/compact navigation, standalone rendering, native blocks, and applicable action/error recovery behavior. Populated native charts must have visible finite drawing geometry and keyboard-accessible exact data with all declared series; a chart title alone does not pass. Verify missing observations remain missing, valid zero and negative observations retain their meaning, and axis/value units match the source. Its report is bound to a private source snapshot, the AppSpec and the renderer build. Do not author or amend that machine report yourself. Its scope is `native-renderer-fixture`: the generated service workflow remains explicitly unverified until separately exercised against its real backend. A supported declared runtime adapter may provide a separate scoped `app-runtime` result; it does not prove browser-to-backend integration. Do not describe fixture data or simulated action responses as real service validation.

Validate the exact primary workflow from entry screen to visible success state. Confirm that controls change real state and that assistant-exposed actions match the native AppSpec contract.

For analytics, derive summary metrics and chart/table totals from the same observations. State each metric's period, scope, unit, formula, and rounding rule. Reconcile regional/category totals with the corresponding headline and trend period; if their scopes differ, disclose the difference beside the values. Give signed adjustments a named source and meaning rather than inventing a disconnected number to demonstrate a negative value. Validate those relationships with calculations, including for synthetic examples, and preserve null observations separately from zero. A schema-valid AppSpec and a browser pass do not establish analytical correctness; record unresolved inconsistencies instead of silently changing source values or marking the analysis verified.

For rendered UI, verify:

- page/surface identity and meaningful non-blank content
- no framework error overlay or relevant console errors
- desktop-window and narrow/compact behavior; mobile when the surface supports it
- default, loading, empty, error, and success states
- keyboard focus, accessible names, contrast, and reduced motion
- charts, tables, icons, and typography are readable at the intended density
- chart marks, legend, axes, units and exact-value data agree; missing series or observations are disclosed, and chart data can be reached by keyboard without hover
- no clipped primary content, nested-card sprawl, filler metrics, inert controls, or generic placeholder copy

Dark-mode release gate:

- activate the real Talome `.dark` theme and inspect every primary surface; a light-theme-only review does not count
- exercise default, hover, focus, selected, disabled, loading, empty, error, success, and overlay states that exist in the primary workflow
- verify normal text meets WCAG AA contrast (4.5:1), large text and essential UI graphics meet 3:1, and visible focus is not lost against dark surfaces
- inspect rendered chart/SVG paint values and confirm gradients, axes, grid lines, labels, nodes, links, legends, and tooltips resolve to visible semantic colors
- reject invalid dynamic CSS identifiers, unresolved `var(...)` colors, black-on-black marks, and transparent primary data
- capture dark-mode evidence for both the desktop window and the supported compact/narrow layout; if Talome intentionally redirects at a breakpoint, record that behavior instead of claiming an untested layout
- check browser console warnings/errors after the interaction pass

Compare the render with the accepted screen spec or concept. Record at least five concrete checks covering hierarchy, layout, typography, palette, component/container model, icon treatment, interaction state, responsive behavior, or motion. Fix material mismatches before setting the validation artifact to complete.

The validation report must include an explicit numbered dark-mode comparison row with the tested surface/state, screenshot or render evidence, and result. Dark-mode evidence is mandatory for `Status: complete`.
