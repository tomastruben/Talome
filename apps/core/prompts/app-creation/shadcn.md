# shadcn Guidance

When UI is needed:

- inspect the target project's `components.json` and installed UI directory before choosing components
- prefer existing `shadcn/ui` components and patterns
- search configured registries before writing a custom primitive; use official component docs and examples rather than guessing APIs
- prefer larger, coherent blocks and flows where they fit the task
- adapt `shadcn/ui` output to Talome conventions instead of using default demo styling
- keep component usage consistent with the surrounding codebase
- use semantic Talome tokens instead of raw colors and use built-in component variants before one-off styling
- compose accessible component anatomy completely: groups around items, titles for dialogs/sheets/drawers, fallbacks for avatars, and proper field structures for forms
- use approved premium shadcn-compatible or Skiper UI components when the license is available and research shows they materially improve the named workflow

Priority order:
1. reuse an existing Talome pattern if one already exists
2. otherwise use a `shadcn/ui` block or cohesive component flow
3. only create a new pattern when neither of the above is a good fit

Do not:
- introduce a parallel design system
- reinstall or overwrite existing components without an explicit compatibility review
- copy community registry components without reviewing imports, dependencies, accessibility, license, icon family, and Talome token usage
- add decorative gradients, heavy shadows, or playful empty-state demos
- use icon or component libraries that conflict with Talome's conventions
