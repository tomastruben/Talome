import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const embedded = vi.hoisted(() => ({ value: false }));
vi.mock("@/hooks/use-desktop-mode", () => ({
  useIsEmbeddedFrame: () => embedded.value,
}));

import {
  SourceList,
  SourceListItem,
  SourceListSection,
  WindowSidebarLayout,
  WindowSidebarSlot,
} from "@/components/ui/source-list";
import { folderIcon } from "@/components/files/files-sidebar";
import { Download01Icon, Folder01Icon } from "@/components/icons";

function Sidebar({ onSelect = vi.fn() }: { onSelect?: () => void }) {
  return (
    <SourceList label="Test sidebar">
      <SourceListSection title="Library">
        <SourceListItem icon={Folder01Icon} label="Movies" active trailing={12} onSelect={onSelect} />
        <SourceListItem label="TV Shows" onSelect={onSelect} />
      </SourceListSection>
    </SourceList>
  );
}

describe("window sidebar", () => {
  beforeEach(() => {
    embedded.value = false;
  });

  it("stays out of the way outside a desktop window", () => {
    render(
      <WindowSidebarLayout sidebar={<Sidebar />}>
        <p>App content</p>
      </WindowSidebarLayout>,
    );

    expect(screen.getByText("App content")).toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "Test sidebar" })).toBeNull();
  });

  it("shows a labelled source list in the window's sidebar slot", () => {
    embedded.value = true;
    const onSelect = vi.fn();
    render(
      <div>
        <WindowSidebarSlot />
        <WindowSidebarLayout sidebar={<Sidebar onSelect={onSelect} />}>
          <p>App content</p>
        </WindowSidebarLayout>
      </div>,
    );

    const nav = screen.getByRole("navigation", { name: "Test sidebar" });
    // Rendered into the window's slot beside the app, not inside the app's own tree
    expect(nav.parentElement?.className).toContain("@2xl:flex");
    expect(nav).toHaveTextContent("Library");
    const movies = screen.getByRole("button", { name: /Movies/ });
    expect(movies).toHaveAttribute("aria-current", "page");
    expect(movies).toHaveTextContent("12");
    screen.getByRole("button", { name: "TV Shows" }).click();
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("gives well-known folders their own icons", () => {
    expect(folderIcon("/data/Downloads")).toBe(Download01Icon);
    expect(folderIcon("/data/Holiday")).toBe(Folder01Icon);
  });
});
