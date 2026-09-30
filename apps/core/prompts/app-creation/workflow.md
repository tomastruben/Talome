# App Design Workflow

Every app follows four gates in order. Do not jump directly from a request to component code.

## Gate 1 — Research

- translate the request into concrete user jobs and measurable outcomes
- inspect the supplied Talome references and source snapshots
- search for relevant GitHub projects, libraries, and proven product patterns when network access is available
- record evidence, license, maintenance signal, compatibility, and a reuse decision in `.talome-creator/research/findings.md`
- distinguish code reuse from visual inspiration; never invent a source or fact

## Gate 2 — Experience design

- map each primary use case to an end-to-end workflow
- define the minimum purposeful screens needed to complete those workflows
- give each screen one user job, one primary action, required data, and default/loading/empty/error/compact states
- choose a coherent visual direction and component family before implementation
- complete `.talome-creator/design/screen-spec.md`

For a bespoke visually led external UI, produce a complete visual concept before coding. For a small native AppSpec surface inside Talome's established system, use Talome references and the AppSpec component registry as the accepted concept instead of generating decorative concept art.

## Gate 3 — Build

- implement the real primary workflow first
- reuse approved Talome, shadcn/ui, Skiper UI, EvilCharts, or researched library components according to the design plan
- preserve provenance and license notices for reused code
- keep native AppSpec actions and Talome Assistant exposure synchronized

## Gate 4 — Verify

- validate the primary workflow, real state changes, responsive desktop-window behavior, compact/mobile behavior when applicable, accessibility, loading/empty/error states, and assistant actions
- run the complete visual and interaction pass with Talome's `.dark` theme active; inspect chart/SVG paint resolution, semantic-token contrast, focus/selection states, desktop-window layout, and supported compact behavior
- compare the rendered result with the accepted visual direction or reference surface
- record at least five concrete comparison points in `.talome-creator/validation/report.md`, including an explicit numbered dark-mode evidence row
- do not report completion while a fixable mismatch or inert primary control remains

Each gate leaves an artifact. Set its `Status` to `complete` only when its evidence is present.

## Completion and publication

Build and exercise the app locally with disposable test data, then clean up temporary test services. Finish the session with the implementation, validation evidence, and remaining limits so Talome can independently validate and publish the app. A prepared workspace is not a published catalog entry; do not install or start the app during generation or modify existing installed services or user data.

After successful publication, installation and startup happen through the app details configure flow. A successful local build or test does not mean the published service is running.
