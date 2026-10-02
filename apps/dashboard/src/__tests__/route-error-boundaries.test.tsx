/**
 * Every route error boundary (the root, the dashboard and each app): the shared
 * error state that fills the window (or page) and centres in its free height,
 * says what failed and how to fix it, and offers Retry. No giant "Error" word
 * at an arbitrary size, and no raw exception text.
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ComponentType } from "react";

import FilesError from "@/app/dashboard/files/error";
import AssistantError from "@/app/dashboard/assistant/error";
import SettingsError from "@/app/dashboard/settings/error";
import ShareError from "@/app/dashboard/share/error";
import DashboardError from "@/app/dashboard/error";
import AppsError from "@/app/dashboard/apps/error";
import NetworkingError from "@/app/dashboard/networking/error";
import AutomationsError from "@/app/dashboard/automations/error";
import BackupsError from "@/app/dashboard/backups/error";
import AudiobooksError from "@/app/dashboard/audiobooks/error";
import StorageError from "@/app/dashboard/storage/error";
import IntelligenceError from "@/app/dashboard/intelligence/error";
import StacksError from "@/app/dashboard/stacks/error";
import ContainersError from "@/app/dashboard/containers/error";
import RootError from "@/app/error";

const SRC = join(__dirname, "..");
const read = (path: string) => readFileSync(join(SRC, path), "utf8");

type Boundary = ComponentType<{ error: Error & { digest?: string }; reset: () => void }>;

const boundaries: Array<[string, Boundary, string, string]> = [
  ["files", FilesError, "app/dashboard/files/error.tsx", "Couldn't open Files"],
  ["assistant", AssistantError, "app/dashboard/assistant/error.tsx", "Couldn't open the Assistant"],
  ["settings", SettingsError, "app/dashboard/settings/error.tsx", "Couldn't open Settings"],
  ["share", ShareError, "app/dashboard/share/error.tsx", "Couldn't open Share"],
  ["dashboard", DashboardError, "app/dashboard/error.tsx", "Couldn't open this page"],
  ["apps", AppsError, "app/dashboard/apps/error.tsx", "Couldn't open the App Store"],
  ["networking", NetworkingError, "app/dashboard/networking/error.tsx", "Couldn't open Networking"],
  ["automations", AutomationsError, "app/dashboard/automations/error.tsx", "Couldn't open Automations"],
  ["backups", BackupsError, "app/dashboard/backups/error.tsx", "Couldn't open Backups"],
  ["audiobooks", AudiobooksError, "app/dashboard/audiobooks/error.tsx", "Couldn't open Audiobooks"],
  ["storage", StorageError, "app/dashboard/storage/error.tsx", "Couldn't open Storage"],
  ["intelligence", IntelligenceError, "app/dashboard/intelligence/error.tsx", "Couldn't open Intelligence"],
  ["stacks", StacksError, "app/dashboard/stacks/error.tsx", "Couldn't open Stacks"],
  ["containers", ContainersError, "app/dashboard/containers/error.tsx", "Couldn't open Containers"],
  ["root", RootError, "app/error.tsx", "Couldn't open Talome"],
];

describe.each(boundaries)("%s error boundary", (_name, Boundary, path, title) => {
  it("names what failed and the fix, and Retry resets the segment", () => {
    const reset = vi.fn();
    render(<Boundary error={new Error("Cannot read properties of undefined (reading 'x')")} reset={reset} />);

    expect(screen.getByText(title)).toBeInTheDocument();
    expect(screen.getByText(/check that (?:.+ and )?the Talome server (?:is|are) running/)).toBeInTheDocument();
    // The raw exception is not the message
    expect(screen.queryByText(/Cannot read properties/)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(reset).toHaveBeenCalledOnce();
  });

  it("fills the view: a flex column holding the shared error state in fill mode", () => {
    const { container } = render(<Boundary error={new Error("boom")} reset={vi.fn()} />);
    const root = container.firstElementChild as HTMLElement;
    // A segment boundary fills its window or page column; the root one has no
    // shell around it, so it fills the screen instead
    expect(root.className).toMatch(path === "app/error.tsx" ? /\bmin-h-screen\b/ : /\bflex-1\b/);
    expect(root.className).toMatch(/\bflex-col\b/);
    const state = container.querySelector('[data-slot="error-state"]') as HTMLElement;
    expect(state).not.toBeNull();
    // fill: no dashed card, takes the free height
    expect(state.className).toMatch(/\bflex-1\b/);
    expect(state.className).not.toMatch(/border-dashed/);
  });

  it("uses no arbitrary sizes, no viewport-height box and no giant word", () => {
    const source = read(path);
    expect(source).toContain("<ErrorState");
    expect(source).toMatch(/\bfill\b/);
    expect(source).not.toMatch(/text-\[\d/);
    expect(source).not.toMatch(/h-\[\d+vh\]/);
    expect(source).not.toMatch(/>\s*Error\s*</);
  });
});

describe("not-found pages", () => {
  it("use the shared empty state with a way home, never an arbitrary-size 404", async () => {
    const { default: NotFound } = await import("@/app/not-found");
    const { default: DashboardNotFound } = await import("@/app/dashboard/not-found");
    for (const [Page, path] of [[NotFound, "app/not-found.tsx"], [DashboardNotFound, "app/dashboard/not-found.tsx"]] as const) {
      const { unmount } = render(<Page />);
      expect(screen.getByText("Page not found")).toBeInTheDocument();
      expect(screen.getByRole("link", { name: "Go to the dashboard" })).toHaveAttribute("href", "/dashboard");
      expect(read(path)).not.toMatch(/text-\[\d/);
      unmount();
    }
  });
});
