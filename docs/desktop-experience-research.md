# Talome Desktop Experience Research

**Date:** 2026-07-19

**Scope:** `apps/dashboard/` — product concept, UX model, frontend architecture, migration strategy

**Status:** Research and recommendation; no desktop UI implementation in this branch

---

## Executive recommendation

Talome can credibly become a browser-based home-server desktop without replacing the product that already exists. The recommended direction is a **permanent complementary desktop mode** that treats existing Talome screens and installed services as applications:

- a restrained top status bar;
- a desktop canvas that can host the existing widgets and pinned shortcuts;
- a bottom dock for favorite and running apps;
- a launchpad for every Talome screen and installed service;
- the existing command palette promoted into system-wide search and actions;
- resizable, movable, minimizable windows for Talome-native screens;
- framed windows for compatible external services, with a first-class new-tab fallback;
- the existing classic and mobile shells continuing as first-class experiences.

Desktop mode is not a migration away from classic mode and should never be presented as its successor. It is another way to use the same capabilities: classic mode is optimized for direct, page-based administration; desktop mode is optimized for spatial workflows, persistent tools, detachable previews, and simultaneous activities. Users can switch modes without losing access to any feature.

The decisive architecture choice is to **render Talome-native app content directly as React components inside windows**. Do not iframe Talome's own routes and do not rewrite the dashboard as micro-frontends. External services may use iframes only when their security policy and authentication model permit it. Existing mobile and compact presentations should become the starting point for narrow window layouts, so responsive windows mostly reuse proven UI rather than create a third presentation of every feature.

The desktop should be inspired by the clarity and spatial model of macOS, Synology DSM, and Umbrel, but it should remain recognizably Talome. Copying macOS chrome literally would create the wrong expectations and compete with the host operating system. Talome's differentiator is not a more realistic desktop metaphor; it is a desktop whose assistant, service health, files, previews, media players, automations, and terminal can stay live and work together in one system context.

## Accepted product decisions

1. **Desktop complements classic mode permanently.** Both modes use the same routes, data, permissions, and feature components.
2. **Existing mobile UI is an asset, not a fallback.** Compact window sizes should deliberately activate the same condensed toolbars, single-column flows, sheets, and player controls that already work on mobile.
3. **Desktop value comes from composition.** The priority is detachable file previews, persistent media players, multiple file browsers and terminals, assistant sidecars, and service windows—not decorative desktop chrome.
4. **Window presentation is additive.** A feature must continue to work in classic and mobile modes before it is considered ready for desktop mode.
5. **Desktop mode is unavailable on mobile.** Mobile devices always use the existing mobile experience; they do not show a desktop-mode switch, desktop route, or forced override.

## Why this fits Talome

Talome already contains most of the required product primitives:

| Desktop capability | Existing Talome foundation | Reuse direction |
|---|---|---|
| App catalog | `components/layout/nav-config.ts` and installed service data | Consolidate into a typed desktop app registry |
| Search / Spotlight | `components/assistant/command-palette.tsx` | Keep the search engine and actions; change the shell presentation |
| Launchpad | `components/widgets/launcher-widget.tsx` and mobile nav grid | Reuse service extraction and icon handling |
| External app preview | `components/quick-look/quick-look.tsx` | Convert from one modal to managed external-app windows |
| Desktop widgets | `components/widgets/widget-grid.tsx` and `hooks/use-widget-layout.ts` | Render on the desktop canvas with the current edit mode |
| Drag-and-drop | `@dnd-kit/*` and `components/draggable-dashboard.tsx` | Keep for icons and widget ordering, not floating window geometry |
| Split panes | `components/ui/resizable.tsx` | Keep for layouts inside an app window |
| Persistent system services | assistant, audio, notifications, automation, cinema, Quick Look providers | Move unchanged above the desktop shell boundary |
| Full-screen applications | terminal, media cinema, file preview | Add a window-aware full-screen/maximize contract |
| PWA presentation | `public/manifest.json` already uses `display: "standalone"` | Preserve and improve the installed-app experience |

This makes the concept less risky than a visual redesign from scratch. The main frontend task is teaching existing responsive presentations to react to their **window container** instead of only the browser viewport. In many cases the compact/mobile design already exists; the work is to expose and trigger it in the correct context.

### Existing rich surfaces to promote into windows

| Existing capability | Current implementation | Desktop opportunity |
|---|---|---|
| File browser | `app/dashboard/files/page.tsx` | Allow multiple folder windows and independent navigation history |
| File Quick Look | `FileQuickLook` in the Files page | Extract into a reusable preview window for images, PDF, Markdown, code, audio, and video |
| Video and movie player | `components/files/media-player.tsx` | Play inline in a window, minimize with live progress, maximize into the existing full-screen/cinema presentation |
| Cinema library | `components/media/cinema-browser.tsx` | Use the library as one window and detach detail or playback into another |
| Audiobook player | `AudiobookPlayerControls`, `GlobalAudioPlayer`, and the singleton audio engine | Keep playback alive across modes; offer mini-player, full player window, and library window |
| Terminal | `TerminalSheet`, `TerminalPage`, and persistent terminal sessions | Multiple resizable terminal windows without inventing a new terminal implementation |
| External service browser | `QuickLookModal` | Promote compatible service previews into persistent service windows |
| Media detail | `UnifiedMediaSheet` | Support sheet presentation in compact windows and a detachable detail window in larger workspaces |
| Assistant | global `AssistantProvider` and command-palette chat mode | Open as a normal app or pin as a sidecar aware of the focused window |

The first prototypes should be built from these surfaces. They exercise the hardest and most interesting desktop behaviors—persistent state, playback, preview, multiple instances, full-screen handoff, and cross-window context—while reusing code Talome already trusts.

## Product model

### The shell

```text
┌────────────────────────────────────────────────────────────────────┐
│ Talome  Active app                         Health  Alerts  20:41  ● │
├────────────────────────────────────────────────────────────────────┤
│                                                                    │
│   desktop widgets                 ┌─────────────────────────────┐   │
│   and pinned shortcuts            │ ●  ●  ●   Services          │   │
│                                    ├─────────────────────────────┤   │
│     ┌──────────┐                   │ existing Talome content     │   │
│     │ CPU  18% │     ┌──────────┐  │ rendered directly          │   │
│     └──────────┘     │ Jellyfin │  │                             │   │
│                      └──────────┘  └─────────────────────────────┘   │
│                                                                    │
│             ┌──────────────────────────────────────────┐           │
│             │ Apps  Files  Media  Assistant  Terminal │           │
│             └──────────────────────────────────────────┘           │
└────────────────────────────────────────────────────────────────────┘
```

The opening view should stay calm. A few user-chosen widgets and shortcuts are enough. The desktop is a workspace, not another dense monitoring dashboard.

### Status bar

The top bar should be 36–40px high and contain only globally useful state:

- **Left:** Talome menu, active application name, and at most one active-app menu.
- **Right:** aggregate system health, active downloads/jobs, notifications, search, local time, and user menu.
- **Overflow:** detailed CPU, memory, network, storage, theme, remote-access, and session controls belong in a compact Control Center popover.

Avoid placing raw metrics across the entire bar. The bar communicates exceptions and access points; widgets and the System Monitor window communicate detail.

### Dock

The dock combines favorites and running state:

- persistent favorites on the left;
- a subtle divider;
- recent/running apps on the right;
- one dot for an open app, a stronger state for its focused window, and a badge only for actionable counts;
- click opens or focuses; clicking an app with multiple windows opens a small window chooser;
- context menu supports Open, New Window where meaningful, Pin/Unpin, Show All Windows, and Quit/Close All;
- the first item opens Launchpad.

Do not use exaggerated magnification or elastic animation. Talome's motion rule (under 200ms, ease-out) is appropriate.

### Launchpad

Launchpad is the complete application catalog, separate from the curated dock. It should combine:

1. Talome apps: Home, Assistant, Media, Audiobooks, Files, Services, App Store, Automations, Intelligence, Terminal, Settings.
2. Installed service apps with a reachable web interface.
3. Utility apps derived from current content: System Monitor, Notifications, Downloads, and optionally Activity.

It needs search, keyboard navigation, permission filtering, and user ordering. Categories are useful only when the catalog becomes large; search remains primary.

### Search

The existing command palette is already more capable than a conventional app launcher. Promote it as **Talome Search**:

- open with `⌘K` / `Ctrl+K`; consider `⌘Space` only as an opt-in because the host OS owns it;
- search apps, services, settings, media, audiobooks, files, containers, automations, and actions;
- default Enter focuses an existing window or opens a new one;
- secondary action opens in a new window;
- preserve the current assistant mode so a search can become an instruction;
- show whether a result opens inside Talome or in a browser tab.

This is where Talome can exceed Umbrel: search is not only navigation, but also a command surface backed by the assistant and live server context.

### Windows

Windows should support the behaviors users actually need:

- focus and z-order;
- drag by title bar;
- resize from edges/corners;
- close, minimize, maximize/restore;
- double-click title bar to maximize/restore;
- snap left/right and optional quarter layouts;
- minimum and preferred size per app;
- remembered size and position;
- off-screen recovery after viewport changes;
- multiple windows only for apps where it adds value (Files, Terminal, media detail, external services);
- a window menu offering non-drag alternatives: Move, Resize, Tile Left, Tile Right, Maximize, Minimize, Close.

Opening a new window must be deliberate. Apple's current window guidance recommends separate windows when they preserve context or enable multitasking, while warning that opening them excessively creates clutter. That is exactly the right rule for Talome.

### Desktop-native compositions to explore

These workflows make desktop mode meaningfully different from opening the classic dashboard in a wider viewport.

#### Files and Quick Look

- Open two independent Files windows to move or compare content across folders.
- Space bar or the existing preview action opens a detachable Quick Look window.
- A preview window can move through sibling files with the existing previous/next behavior while the file browser remains usable.
- Video and audio files use the existing players; PDF, image, Markdown, code, and text reuse the existing preview components.
- A preview may be pinned above other windows or minimized without closing the underlying Files window.

The extraction boundary should be a reusable `FilePreview` component. The current `FileQuickLook` is private to the Files route and already contains nearly all of the content selection and navigation behavior.

#### Media library and movie player

- Keep the cinema or media library open while a movie detail window is visible beside it.
- Start playback in a normal resizable player window using the existing compact controls.
- Maximize the player into the existing cinema/full-screen presentation rather than implement a second large-player UI.
- Minimize playback into a live dock item or small “Now Playing” surface with progress and transport controls.
- Restore the player without restarting playback or losing subtitle, quality, speed, chapter, HLS, Jellyfin, Picture-in-Picture, or AirPlay state.

The player is a persistent activity owned by the media engine, not disposable state owned by window chrome. Closing a player window should ask whether to stop playback or keep it minimized when media is active.

#### Audiobooks and persistent audio

- Keep the audiobook library in one window and the current book/player in another.
- Reuse the singleton audio engine so switching classic/desktop mode or minimizing a window does not restart playback.
- Offer the existing compact player as a dock/status-bar mini-player and `AudiobookPlayerControls` inside an expanded player window.
- Let chapters or book details open beside the player without duplicating playback state.

#### Operate and troubleshoot

- Open Services, a container detail/log window, Terminal, and an Assistant sidecar together.
- Let “Ask Talome” include the focused service, selected log lines, terminal session, or file as structured context.
- Keep external service Quick Look windows alongside Talome-native monitoring tools when framing is supported.

#### Window families

A dock application may own several related windows. For example, Files can own browser and preview windows; Media can own library, detail, and player windows. The dock should group them under one app icon while the window switcher exposes individual titles. This avoids treating every preview or player as an unrelated application.

### Availability by device

Talome already has mobile presentations. Desktop work should reuse their component behavior, not redesign mobile navigation or make desktop mode available on mobile. The mobile shell remains the only mode on mobile devices. Compact desktop windows can still reuse the same condensed content patterns when a desktop user resizes a window narrowly.

| Surface | Recommended behavior |
|---|---|
| Mobile phone or mobile browser | Existing mobile shell and full-screen pages only; desktop mode is not exposed |
| Tablet / touch-first mobile device | Existing mobile/compact experience only; desktop mode is not exposed |
| Desktop-class browser / installed desktop PWA | Classic mode and desktop mode are both available |

Inside desktop mode, responsive behavior is based on each window's content width. A 480px Files window should render the same condensed controls and single-column flow as the established 480px mobile view, even when the browser itself is 1440px wide. Mode choice is available only in a desktop-class environment, where it remains a user preference and does not remove or supersede classic mode.

## Application model

Create one registry as the source of truth for navigation, launchpad, dock, permissions, search, window defaults, and external launch behavior.

```ts
interface DesktopAppDefinition {
  id: string;
  title: string;
  icon: IconSvgElement | AppIconSource;
  kind: "native" | "external" | "utility";
  permission?: FeaturePermission;
  adminOnly?: boolean;
  launch: NativeLaunch | ExternalLaunch;
  window: {
    preferredSize: { width: number; height: number };
    minSize: { width: number; height: number };
    allowMultiple: boolean;
    resizable: boolean;
  };
}

interface DesktopWindowState {
  id: string;
  appId: string;
  title: string;
  instanceKey?: string;
  bounds: { x: number; y: number; width: number; height: number };
  restoreBounds?: DesktopWindowState["bounds"];
  state: "normal" | "minimized" | "maximized" | "snapped-left" | "snapped-right";
  zIndex: number;
  href?: string;
}
```

Dynamic service apps should be converted into the same definition shape after `useServiceStacks()` resolves. This removes duplicated launchable-service extraction currently present in the launcher and command palette.

## Architecture options considered

| Option | Advantages | Problems | Decision |
|---|---|---|---|
| Iframe existing Talome routes | Fastest visual prototype; hard isolation | Duplicated shell/providers, extra data fetching, nested history, focus/accessibility issues, higher memory, awkward authentication | Prototype spike only; reject for product architecture |
| Extract route screens and render directly | Shared state and providers, best performance, accessible DOM, native-feeling windows | Requires page extraction and container-responsive audit | **Recommended** |
| Next.js parallel routes per window | Native routing and independent loading/error states | URL cannot cleanly model arbitrary ordered windows; refresh/default-slot complexity in Next.js 16 | Useful for a few route-backed modals, not the window manager |
| Micro-frontends | Strong isolation and independent deployability | Major operational and design-system complexity with no present need | Reject |
| Browser `window.open()` for each app | Real OS windows and isolation | Popup blocking, poor mobile behavior, cannot provide one coherent Talome desktop | Offer only as an explicit external action |

### Recommended component structure

```text
DashboardShell
├── global providers (assistant, notifications, audio, automation, Quick Look)
└── AdaptiveShell
    ├── ClassicDashboardShell             # current navigation; retained during rollout
    └── DesktopShell
        ├── DesktopStatusBar
        ├── DesktopSurface
        │   ├── DesktopWidgetLayer
        │   ├── DesktopShortcutLayer
        │   └── WindowLayer
        │       └── DesktopWindow[]
        │           └── DesktopAppHost
        ├── DesktopDock
        ├── Launchpad
        ├── TalomeSearch                   # existing command palette engine
        └── DesktopControlCenter
```

The state boundary should be a `DesktopProvider` or a small set of Jotai atoms with command-style actions (`openApp`, `focusWindow`, `moveWindow`, `resizeWindow`, `minimizeWindow`, `closeWindow`, `restoreWorkspace`). Window state must not be coupled to individual window components.

### Rendering existing pages

Most dashboard routes are client components, but several are very large. Route files should become thin adapters:

```tsx
// route
export default function FilesPage() {
  return <FilesScreen presentation="route" />;
}

// desktop app host
<FilesScreen presentation="window" windowId={windowId} />
```

The extraction must preserve current URLs for deep links, reloads, browser history, sharing, and the classic shell. A desktop launch can update a compact route such as `/dashboard?app=files&path=...` for the focused app, while the complete workspace remains persisted separately. Do not serialize every window movement into browser history.

The `presentation` prop does not select a separate visual design. It supplies shell behavior—where page actions render, whether global breadcrumbs are present, how full-screen is requested, and whether a detail opens as a sheet or sibling window. Content density should continue to follow responsive size.

```ts
type AppPresentation = "classic" | "desktop-window";
type AppSizeClass = "compact" | "regular" | "wide";

interface AppSurfaceContextValue {
  presentation: AppPresentation;
  sizeClass: AppSizeClass;
  requestOpenSurface(input: SurfaceRequest): void;
  requestFullscreen(): void;
  requestMinimize(): void;
}
```

This contract allows existing content to request “preview this file”, “play this movie”, or “open this terminal” without knowing whether the result should be a classic sheet, a mobile full-screen view, or a desktop sibling window.

### Container responsiveness is the main migration

The current shell declares a container on its main area, but only a small number of explicit `@container` rules exist. Most Tailwind `sm:`, `md:`, and `lg:` utilities still respond to the browser viewport. Therefore a narrow window inside a wide browser can fail to activate the mobile/compact presentation that already exists.

Each app needs a supported size contract:

| Size class | Approximate content width | Expected behavior |
|---|---:|---|
| Compact | 360–559px | Single column, condensed toolbar, sheets for detail |
| Regular | 560–899px | Primary layout, optional collapsible secondary pane |
| Wide | 900px+ | Current multi-column/table layouts where appropriate |

`DesktopWindowBody` should establish `container-type: inline-size`, and app screens should migrate existing breakpoint decisions to named container variants, CSS container queries, or a shared `useAppSizeClass()` hook. The goal is to reuse established compact behavior, not manually maintain parallel mobile and window markup. Browser-viewport media queries remain appropriate only for the outer classic/mobile/desktop shell choice.

Start with screens and sub-surfaces that are already naturally bounded: Terminal, the compact media player, the audiobook controls, file previews, Services, and dashboard widgets. Files, Media, Audiobooks, Assistant, and Intelligence still require dedicated container audits because their route components are large and contain full-screen or nested navigation assumptions, but their existing mobile presentations substantially reduce design work.

## Window geometry and library choice

### Recommended prototype choice: `react-rnd`

As of this research, `react-rnd` 10.5.3 is an MIT-licensed, typed React wrapper with controlled position/size, bounds, drag handles, and resize callbacks. Its peer range includes current React. It is small enough to isolate behind Talome's own `DesktopWindowFrame` component.

Use it only for pointer geometry. Talome must still own:

- window state and z-order;
- viewport reconciliation and off-screen recovery;
- snap/maximize transitions;
- keyboard and menu alternatives;
- focus management;
- persistence;
- title-bar and resize-handle design.

During a pointer move, update the element transform locally and commit the final bounds to the shared store on stop. Avoid causing the entire window layer to rerender on every pointer event.

### Other candidates

| Tool | Best use | Assessment |
|---|---|---|
| Existing `@dnd-kit` | Widget/icon ordering and keyboard-reorder flows | Keep; it is not a complete freeform resize/window solution |
| Existing `react-resizable-panels` | Split views inside Files, Settings, Assistant, or inspectors | Keep; not a floating window manager |
| `interact.js` | Fine-grained pointer gestures, snapping, restrictions, multi-touch | Capable, but imperative React integration and a larger API surface make the first implementation more complex |
| Custom Pointer Events | Maximum control and smallest dependency surface | Consider only after the interaction contract is proven; easy to get touch, selection, bounds, and accessibility wrong |
| `react-grid-layout` | Responsive dashboard grids | Not suitable for overlapping desktop windows; current Talome widget grid already covers this need |

Regardless of library, observe the desktop surface with `ResizeObserver` and reconcile every normal window into the new safe rectangle when the browser, PWA window, status bar, dock, or audio player changes size.

## External service windows

External services are the most important technical limitation.

1. A service may set `Content-Security-Policy: frame-ancestors` or `X-Frame-Options`, which can block embedding.
2. Cross-origin policy prevents Talome from reading or controlling most iframe content.
3. Browser privacy policy can partition or block cookies/storage in a third-party frame.
4. Service-specific redirects, WebSockets, absolute paths, and authentication may fail behind a generic reverse proxy.

Do not promise that every installed service runs inside a Talome window. Model launch capability explicitly:

```ts
type ExternalLaunchMode = "embed" | "external" | "ask";
```

Recommended behavior:

- store a default launch mode per service, with user override;
- use an iframe only for services known or configured to support embedding;
- keep the iframe sandbox permission list minimal and service-specific;
- show a loading state with a clear “Open in browser” action;
- never strip security headers or proxy credentials merely to make framing work;
- mark external-tab apps clearly in Launchpad and Search;
- offer a future `postMessage` integration contract for Talome-aware generated apps.

The current Quick Look iframe can seed the experience, but iframe `onError` is not a reliable detector for frame-policy rejection. A research spike should inventory the most common Talome store apps and record embed success, authentication behavior, navigation, downloads, clipboard, WebSockets, and full-screen behavior.

## State, restoration, and routing

Use two persistence layers:

- **Phase 1:** versioned `localStorage`, following the existing widget-layout migration pattern; per browser/device.
- **Later:** user workspace records in SQLite for cross-device restoration, with last-write/version semantics.

Persist only stable intent:

- pinned dock apps and their order;
- desktop shortcuts and widget layout;
- open app instances;
- normal/restore bounds;
- minimized/maximized/snapped state;
- selected workspace;
- desktop-mode preference.

Do not persist z-index numbers indefinitely. Normalize ordering when saving. On restoration, validate permission and app availability, clamp geometry to the current safe area, and discard unknown schema versions through an explicit migration.

For minimized native windows, React 19.2's `<Activity mode="hidden">` is worth a focused experiment: it preserves component state while hiding DOM and unmounting effects. External iframes need a separate policy because hidden frames can continue consuming resources or lose authentication when unloaded.

## Accessibility and input requirements

Floating windows are a custom GUI, so accessibility must be designed into the contract:

- every title bar and window has an accessible name;
- focused and inactive windows are visually distinct without relying only on color;
- focus moves into a newly opened window and returns to the launcher when it closes;
- non-modal windows do not trap focus;
- modal dialogs inside a window remain modal only to the relevant active surface;
- window controls are real buttons with stable labels;
- resizing and movement have menu/button alternatives, not drag-only operation;
- keyboard resize uses arrow keys in a dedicated resize mode and announces the resulting size;
- a “Reset window positions” command always recovers lost content;
- touch handles are large enough without making the chrome visually heavy;
- `prefers-reduced-motion` removes scale/slide transitions;
- no important command is available only through right-click or hover.

WCAG 2.2 success criterion 2.5.7 requires a non-dragging alternative for dragging interactions. The WAI-ARIA splitter pattern also provides a useful keyboard model for any resizable split panes inside an app.

## Security boundaries

- Continue enforcing `RouteAccessGuard` and permission filtering at content render time; hiding an icon is not authorization.
- Never expose the Docker socket to framed apps or the browser.
- Treat external service windows as untrusted origins even when they are on the LAN.
- Never inject Talome API tokens into iframe URLs.
- Keep `allow-top-navigation` disabled unless a specific integration requires user-activated navigation.
- Do not add `allow-same-origin` and `allow-scripts` casually; sandbox permissions need a threat-model review per service class.
- Ensure clickjacking protection on Talome itself remains correct if same-origin route framing is used during a throwaway prototype.
- Preserve the current PWA and secure session behavior across standalone and browser display modes.

## Performance budget

The browser desktop must remain viable on home-server clients and low-power tablets.

- Default maximum of six mounted native windows during the prototype; measure before changing.
- Mount window content lazily when first opened.
- Hidden native windows should pause effects with `<Activity>` if the experiment validates it.
- Hidden external frames should be suspended or explicitly kept alive based on an app policy.
- Pointer movement should mutate only transform/size presentation and commit state at interaction end.
- Use one global subscription for system health/download/notification state rather than one poller per window.
- Preserve SWR cache keys so route and window presentations share fetched data.
- Avoid backdrop blur over the entire desktop; restrict it to small shell surfaces if GPU profiling permits.
- Test 1, 3, and 6 simultaneous windows with Terminal output, Assistant streaming, a media surface, and an external iframe.

## Delivery plan

### Phase 0 — interaction contract and inventory (research spike)

**Goal:** remove unknowns before a visual rewrite.

- Create the app registry type and map current navigation/services without changing the UI.
- Inventory existing mobile/compact behavior and minimum/ideal sizes for each native screen.
- Define the surface request contract for previews, players, details, terminal sessions, and external services.
- Test iframe compatibility for the highest-use store apps.
- Build a disposable window geometry playground around real bounded surfaces: Terminal, file preview, and compact video or audiobook player.
- Validate pointer, touch, keyboard alternative, snapping, viewport resize, active playback, PWA standalone mode, and reduced motion.

**Exit:** library and state model selected; responsive and embed inventories written down.

### Phase 1 — complementary desktop shell MVP

**Goal:** a useful desktop behind a user setting or feature flag.

- Status bar, desktop surface, dock, launchpad, and Talome Search shell.
- Desktop windows for Terminal, Files, detachable file preview, one media player, Services, and one utility/System Monitor app.
- Player minimize/restore behavior that preserves active playback.
- Local workspace persistence and off-screen recovery.
- Classic mode remains permanently available and is not treated as a rollback path.
- Mobile devices continue to use the current mobile experience exclusively; the desktop setting and shell are unavailable there.

**Exit:** a user can browse files, detach a preview or player, keep Terminal or Services open beside it, reload, and recover the workspace without losing active application state.

### Phase 2 — content apps and external services

**Goal:** expand the complementary desktop experience to the complete Talome content set.

- Extract and container-adapt Files, Assistant, Media, Audiobooks, App Store, Automations, and Intelligence incrementally.
- Convert Quick Look into external app windows.
- Add launch-mode settings and the compatibility/fallback UX.
- Add window switcher, snap layouts, multiple Files/Terminal instances, dock player controls, and deep links.

**Exit:** desktop mode supports the majority of everyday Talome workflows while classic mode remains equally available and shares the same feature components.

### Phase 3 — Talome-native advantages

**Goal:** go beyond a visual desktop metaphor.

- Assistant understands the active window, selected services/files/media, and workspace layout.
- Search runs safe actions directly and explains results.
- Intelligent window suggestions: open logs beside an unhealthy service, terminal beside an approved fix, or media details beside downloads.
- Named workspaces such as “Operate”, “Media”, and “Develop”.
- Optional server-synced workspace state.

This phase is the product moat. A polished dock alone is easy to copy; contextual orchestration across apps is not.

## MVP acceptance criteria

The first production-capable slice should not be judged only by appearance.

1. Open Files, a detachable preview/player, and Terminal or Services from the dock; all remain live.
2. Move, resize, focus, minimize, maximize, tile, restore, and close with pointer and non-drag controls.
3. Reload and restore a valid layout without off-screen windows.
4. Resize a window through compact, regular, and wide sizes; it reuses the established responsive presentation without clipped primary actions.
5. Use keyboard-only navigation to launch, switch, operate, and close windows.
6. Search focuses an already-open app rather than creating duplicates by default.
7. Permission changes remove inaccessible apps and close/replace their restored windows safely.
8. An incompatible external app produces a clear new-tab fallback, not a blank window.
9. Active video or audiobook playback survives minimize/restore and switching between desktop and classic modes.
10. Terminal streaming and Assistant activity continue correctly while another window is focused.
11. Classic and desktop modes can be switched instantly from Settings; neither is described or implemented as recovery for the other.
12. On mobile, no desktop-mode control or route is available and the existing mobile shell is unchanged.

## Risks and mitigations

| Risk | Severity | Mitigation |
|---|---|---|
| Existing pages fail to activate compact layouts in narrow windows | High | Reuse mobile behavior through container size classes and per-app audits |
| Many mounted screens over-poll APIs | High | Shared SWR keys, centralized system subscriptions, hidden-window lifecycle policy |
| External services reject or break in iframes | High | Explicit launch capability, compatibility inventory, first-class external fallback |
| Desktop feels like novelty chrome | High | Keep shell restrained; prioritize real multitasking and assistant workflows |
| Mobile experience regresses | High | Leave the mobile shell intact and reuse its content patterns inside compact desktop windows |
| Keyboard and screen-reader use becomes confusing | High | Window focus contract, non-drag controls, accessibility tests from Phase 0 |
| Route/page extraction causes broad regressions | Medium | Thin route adapters, one application at a time, classic shell retained |
| Window state becomes corrupted or off-screen | Medium | Versioned schema, validation, clamping, reset command, safe default workspace |
| macOS imitation creates mismatched expectations | Medium | Talome-specific chrome, behavior documented and consistently implemented |

## Decisions to make before implementation

1. Should the default desktop surface be mostly empty, or ship with a restrained four-widget system overview?
2. Which existing player should prove persistent minimize/restore first: movie/video or audiobook?
3. Should file previews always open as sibling windows, or use Quick Look first with an explicit detach action?
4. Which external apps are important enough to include in the initial iframe compatibility matrix?
5. Should closed apps restore after sign-in, or only after a browser refresh on the same device?
6. Are multiple named workspaces an MVP requirement or a Phase 3 feature?
7. Should the top-left use an active-app menu model, or only a Talome system menu for simplicity?

Recommended defaults: four restrained widgets; prove movie/video playback first because it exercises compact, full-screen, cinema, HLS, Picture-in-Picture, and external playback behavior; open Quick Look with an explicit detach action; test the most common media, networking, and home-automation services; restore on the same device; defer named workspaces; use only a Talome system menu in MVP.

## Research sources

- [Apple Human Interface Guidelines: Windows](https://developer.apple.com/design/human-interface-guidelines/windows) — window purpose, state, sizing, multitasking, and avoiding excessive new windows.
- [Apple: Getting oriented with the desktop, menu bar, Spotlight, and Dock](https://support.apple.com/guide/macbook-air/are-you-new-to-mac-apd1f14ec646/mac) — the familiar shell model being adapted, not copied.
- [Umbrel: What is Umbrel?](https://umbrel.com/support/getting-started/what-is-umbrel) and [umbrelOS product overview](https://umbrel.com/umbrelos) — current browser-managed home-server OS positioning, app store, system usage, and search.
- [Synology DSM user guide](https://global.download.synology.com/download/Document/Software/UserGuide/Os/DSM/7.1/enu/Syno_UsersGuide_NAServer_7.1_enu.pdf) — mature browser desktop patterns including a desktop, taskbar, app windows, shortcuts, and pinned/open apps.
- [MDN: PWA `display`](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Manifest/Reference/display) and [Create a standalone app](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/How_to/Create_a_standalone_app) — standalone presentation and browser fallback behavior.
- [MDN: CSP `frame-ancestors`](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/frame-ancestors), [same-origin policy](https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Same-origin_policy), and [`iframe` sandbox](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/iframe) — external app embedding and security constraints.
- [Next.js: Parallel Routes](https://nextjs.org/docs/app/api-reference/file-conventions/parallel-routes) and [Next.js 16 upgrade guidance](https://nextjs.org/docs/app/guides/upgrading/version-16) — why route slots help bounded modal/layout cases but are not the entire workspace state model.
- [React 19.2: Activity](https://react.dev/blog/2025/10/01/react-19-2) and [`<Activity>` reference](https://react.dev/reference/react/Activity) — preserving hidden native app state while pausing effects.
- [`react-rnd` package](https://www.npmjs.com/package/react-rnd) and [interact.js restriction/resizing documentation](https://interactjs.io/docs/restriction/) — window geometry implementation candidates.
- [MDN: Resize Observer API](https://developer.mozilla.org/en-US/docs/Web/API/Resize_Observer_API) — reconciling windows and responsive content to container changes.
- [WCAG 2.2: Understanding dragging movements](https://www.w3.org/WAI/WCAG22/Understanding/dragging-movements) and [WAI-ARIA window splitter pattern](https://www.w3.org/WAI/ARIA/apg/patterns/windowsplitter/) — required alternatives to pointer dragging and keyboard resize patterns.

## Bottom line

Build a Talome desktop, not a macOS skin and not a replacement for classic mode. Reuse the existing mobile layouts, browsers, previews, players, terminal, content, and providers; introduce a typed app/window/surface model; treat external framing as a capability rather than an assumption; and ship desktop mode incrementally beside classic mode on desktop-class environments only. Mobile keeps its existing shell exclusively, even though its responsive components are reused inside narrow desktop windows. Once the fundamentals are reliable, the assistant can turn these already-rich components into something materially more powerful than Umbrel or DSM: a composable workspace that understands and operates the home server as one system.
