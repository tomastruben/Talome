# Talome Design Language

Talome already has a design system and a recognizable UI voice. Treat the existing Talome codebase as the primary design reference.

Rules:
- study the provided Talome reference files before generating UI
- match Talome's spacing rhythm, density, and interaction style
- keep surfaces calm, reduced, and task-first
- prefer one primary action per screen
- default to dark-mode-friendly styling
- use the same visual family as Talome, not generic starter-app styling

Dark-mode contract:
- dark mode is the canonical Talome render, not an optional theme or a late polish pass
- render every primary surface with the `.dark` theme active before declaring it complete
- verify semantic-token contrast for text, controls, borders, focus rings, selected states, disabled states, overlays, and status colors
- inspect SVG and canvas output directly: chart axes, grid lines, gradients, nodes, links, legends, and tooltips must remain distinguishable from the background
- keep chart/config identifiers CSS-safe; user-facing labels may contain spaces, but never interpolate those labels directly into CSS custom-property names, selectors, SVG IDs, or paint URLs
- a black, transparent, or unresolved visualization on a dark surface is a release blocker even when the data and DOM are present
- verify dark mode at the normal desktop window size and at the compact/narrow size supported by the surface

Practical guidance:
- reuse familiar page structure, card structure, and header patterns
- mirror Talome's tone: direct, quiet, low-noise
- never use a Wi-Fi icon as a generic app icon, AI symbol, server symbol, status decoration, or connectivity metaphor
- a Wi-Fi icon is allowed only when the screen is explicitly presenting real Wi-Fi or wireless-network state; otherwise choose a domain-specific HugeIcon or app emoji
- prefer existing component structure and nearby page patterns over inventing a new visual grammar
- choose components in this order: existing Talome components, polished shadcn/ui primitives or blocks, approved Skiper UI components, then custom code
- premium shadcn-compatible and Skiper UI Pro components may be used only when Talome has the required license and they materially improve the task
- treat imported component source as a starting point: convert it to Talome semantic tokens, HugeIcons, typography, spacing, motion, accessibility, and responsive window behavior
- never copy a decorative Skiper UI effect unchanged; remove gradients, bounce, spring overshoot, parallax, cursor effects, or visual noise that conflicts with Talome's restraint
- never expose or commit a component-registry license key
- generated UI should look like it belongs next to existing Talome screens on first render
