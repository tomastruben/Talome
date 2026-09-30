import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import type { FeaturePermission } from "@talome/types";
import {
  allNav,
  approvalsNavItem,
  canSeeNavItem,
  humanizeSlug,
  navTitleForPath,
  paletteNavCommands,
  visibleNavItems,
} from "@/components/layout/nav-config";
import { SHORTCUTS, SHORTCUT_HINTS } from "@/lib/keymap";
import { OPEN_PALETTE_EVENT, openPalette, paletteRequestFromEvent } from "@/lib/palette";

const SRC = join(__dirname, "..");
const read = (path: string) => readFileSync(join(SRC, path), "utf8");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name === "__tests__" || name === "node_modules") continue;
      walk(path, out);
    } else if (/\.tsx?$/.test(name)) {
      out.push(path);
    }
  }
  return out;
}

const admin = { isAdmin: true, hasPermission: () => true };
const member = (denied: FeaturePermission[] = []) => ({
  isAdmin: false,
  hasPermission: (feature: FeaturePermission) => !denied.includes(feature),
});

describe("shortcut hints (P0-14)", () => {
  it("registers a handler for every shortcut in the keymap", () => {
    for (const [id, shortcut] of Object.entries(SHORTCUTS)) {
      const source = read(shortcut.handledIn);
      const usesKeymap = source.includes(`SHORTCUTS.${id}.matches`);
      const literalBugHunt = id === "bugHunt" && /e\.shiftKey && e\.key\.toLowerCase\(\) === "x"/.test(source);
      expect(usesKeymap || literalBugHunt, `${id} in ${shortcut.handledIn}`).toBe(true);
    }
  });

  it("matches the right key events and never a browser-reserved combination", () => {
    expect(SHORTCUTS.palette.matches({ key: "k", metaKey: true, ctrlKey: false, shiftKey: false, altKey: false })).toBe(true);
    expect(SHORTCUTS.palette.matches({ key: "K", metaKey: false, ctrlKey: true, shiftKey: false, altKey: false })).toBe(true);
    expect(SHORTCUTS.chat.matches({ key: "/", metaKey: false, ctrlKey: false, shiftKey: false, altKey: false })).toBe(true);
    expect(SHORTCUTS.bugHunt.matches({ key: "X", metaKey: true, ctrlKey: false, shiftKey: true, altKey: false })).toBe(true);
    for (const hint of SHORTCUT_HINTS) expect(hint).not.toMatch(/^⌘[0-9TWN,]$/);
  });

  it("shows no dead ⌘1–7, ⌘, or ⌘T hints in the palette (regression)", () => {
    const palette = read("components/assistant/command-palette.tsx");
    expect(palette).not.toMatch(/⌘[0-9T,]/);
    const shortcuts = palette.match(/<CommandShortcut>([^<]*)<\/CommandShortcut>/g) ?? [];
    expect(shortcuts.length).toBeGreaterThan(0);
    for (const shortcut of shortcuts) expect(shortcut).toMatch(/\{SHORTCUTS\.\w+\.hint\}/);
  });

  it("opens the palette through one event instead of a synthetic ⌘K keydown", () => {
    const offenders = walk(SRC)
      .filter((path) => /new KeyboardEvent\("keydown", \{ key: "k"/.test(readFileSync(path, "utf8")))
      .map((path) => relative(SRC, path));
    // Community tools (settings, W3) still uses it; everything in the shell doesn't.
    expect(offenders.filter((path) => !path.startsWith("components/settings/"))).toEqual([]);

    const seen: unknown[] = [];
    const listener = (event: Event) => seen.push(paletteRequestFromEvent(event));
    document.addEventListener(OPEN_PALETTE_EVENT, listener);
    openPalette({ mode: "chat", prefill: "Diagnose" });
    openPalette();
    document.removeEventListener(OPEN_PALETTE_EVENT, listener);
    expect(seen).toEqual([{ mode: "chat", prefill: "Diagnose" }, { mode: "search", prefill: undefined }]);
  });
});

describe("nav labels and visibility come from nav-config (P0-14)", () => {
  it("titles the header from the nav, never a raw slug (regression: 'backups')", () => {
    expect(navTitleForPath("/dashboard/backups")).toBe("Backups");
    expect(navTitleForPath("/dashboard")).toBe("Home");
    expect(navTitleForPath("/dashboard/containers")).toBe("Services");
    expect(navTitleForPath("/dashboard/apps/talome/jellyfin")).toBe("App Store");
    expect(navTitleForPath("/dashboard/storage")).toBe("Storage");
    expect(navTitleForPath("/dashboard/settings/approvals")).toBe("Approvals");
    expect(navTitleForPath("/dashboard/some-new-page")).toBe("Some new page");
    expect(humanizeSlug("media-player")).toBe("Media player");
  });

  it("hides admin-only items (Terminal, Bug Hunt) and denied features from members everywhere", () => {
    const titles = (items: { title: string }[]) => items.map((item) => item.title);
    expect(titles(visibleNavItems(allNav, member()))).not.toContain("Terminal");
    expect(titles(visibleNavItems(allNav, member()))).not.toContain("Bug Hunt");
    expect(titles(visibleNavItems(allNav, member(["media"])))).not.toContain("Media");
    expect(titles(visibleNavItems(allNav, admin))).toEqual(expect.arrayContaining(["Terminal", "Bug Hunt"]));
    expect(canSeeNavItem(approvalsNavItem, member())).toBe(false);
  });

  it("gives the palette the sidebar's names, icons and rules", () => {
    const memberCommands = paletteNavCommands(member(["automations"]), false);
    expect(memberCommands.map((c) => c.label)).not.toContain("Terminal");
    expect(memberCommands.map((c) => c.label)).not.toContain("Automations");
    // Bug Hunt is an overlay action, not a navigation target.
    expect(paletteNavCommands(admin, false).map((c) => c.label)).not.toContain("Bug Hunt");
    const intelligence = allNav.find((item) => item.title === "Intelligence")!;
    expect(paletteNavCommands(admin, false).find((c) => c.label === "Intelligence")?.icon).toBe(intelligence.icon);
    expect(paletteNavCommands(admin, true)[0]).toMatchObject({ label: "Widgets", path: "/dashboard" });
  });

  it("keeps the header, mobile nav and palette off hand-written label tables", () => {
    expect(read("components/layout/site-header.tsx")).not.toMatch(/const pathLabels/);
    expect(read("components/assistant/command-palette.tsx")).not.toMatch(/const NAV_COMMANDS/);
  });
});

describe("icons (D-P0-8)", () => {
  it("never imports lucide-react outside the vendored ui primitives", () => {
    const offenders = walk(SRC)
      .filter((path) => !relative(SRC, path).startsWith("components/ui/"))
      .filter((path) => /from\s+["']lucide-react["']/.test(readFileSync(path, "utf8")))
      .map((path) => relative(SRC, path));
    expect(offenders).toEqual([]);
  });

  it("does not use the Wi-Fi icon for terminal remote sessions", () => {
    for (const path of ["components/desktop/desktop-window.tsx", "components/layout/site-header.tsx"]) {
      expect(read(path), path).not.toMatch(/Wifi01Icon/);
    }
  });

  it("keeps one copy of the Talome mark in the shell", () => {
    for (const path of [
      "components/layout/app-sidebar.tsx",
      "components/layout/mobile-nav.tsx",
      "components/desktop/desktop-experience.tsx",
    ]) {
      expect(read(path), path).not.toMatch(/cx="17\.1" cy="7"/);
      expect(read(path), path).toContain("TalomeMark");
    }
  });
});
