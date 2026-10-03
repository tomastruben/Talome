# Desktop and installed experience contract

Extend the existing blueprint and screen specification; do not invent a second specification.

For every primary user outcome, identify its native surface and action IDs, or its original-interface workflow. State whether the result is native, external, or hybrid. A status dashboard does not fulfill a specialized interactive task such as editing, drawing, or manipulating a 3D viewport. If the native renderer cannot represent the main job, explain that boundary and provide a clear opening path to the real interface.

Talome owns desktop windows, controls, shared titles, back navigation, toolbars and sidebars. Embedded apps must use the existing desktop toolbar/sidebar integration. Do not recreate window controls, duplicate headers, or nest whole app windows. State the minimum useful content width, compact navigation, resizing behavior and overlay/handoff behavior. Keep control sizes consistent on iPad; do not add touch-only enlargement or status-bar compensation.

Read the current theme, button, search, desktop toolbar/sidebar and native renderer snapshots in `.talome-creator/references`. `design-foundations.json` fingerprints those files. Use semantic tokens and existing primitives in both themes, shared rounded controls, restrained motion under 200ms, and reduced-motion support. For a generated original interface, adapt the same foundations instead of introducing another component library or visual system.

Generated app-api sources/actions require a real installed service connection. Personal apps with one published web port can resolve it automatically; multi-port apps must declare the manifest webPort (host port) unambiguously. Explicit URL/credential settings remain authoritative. The service must expose the exact declared paths, request inputs and response fields; a simulated native response is not service validation.

In the screen specification, include a table mapping each primary use case to its surface/action or original-interface entry, visible success state, data source/service endpoint and recovery behavior. In the validation report distinguish configuration, native renderer fixtures, actual service behavior, and installed browser-to-service integration. Do not call an app verified because the container is Running. Mark any untested scope explicitly.

Validate dark and light themes at normal desktop, narrow desktop window, and tablet widths. Also inspect standalone rendering. Check keyboard navigation, primary-action visibility, clipping, overlays and assistant handoff. Preserve evidence tied to the tested source revision. Real workflow verification must include action followed by read-back, restart/persistence where relevant, and recovery from missing/unavailable service data.
