# shadcn Guidance

When UI is needed:

- prefer existing `shadcn/ui` components and patterns
- prefer larger, coherent blocks and flows where they fit the task
- adapt `shadcn/ui` output to Talome conventions instead of using default demo styling
- keep component usage consistent with the surrounding codebase

Priority order:
1. reuse an existing Talome pattern if one already exists
2. otherwise use a `shadcn/ui` block or cohesive component flow
3. only create a new pattern when neither of the above is a good fit

Do not:
- introduce a parallel design system
- add decorative gradients, heavy shadows, or playful empty-state demos
- use icon or component libraries that conflict with Talome's conventions
