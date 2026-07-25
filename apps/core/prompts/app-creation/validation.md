# Design and Workflow Validation

A build or typecheck is necessary but not sufficient.

Validate the exact primary workflow from entry screen to visible success state. Confirm that controls change real state and that assistant-exposed actions match the native AppSpec contract.

For rendered UI, verify:

- page/surface identity and meaningful non-blank content
- no framework error overlay or relevant console errors
- desktop-window and narrow/compact behavior; mobile when the surface supports it
- default, loading, empty, error, and success states
- keyboard focus, accessible names, contrast, and reduced motion
- charts, tables, icons, and typography are readable at the intended density
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
