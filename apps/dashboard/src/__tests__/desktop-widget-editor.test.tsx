import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { WidgetAddDock } from "@/components/widgets/widget-grid";

describe("desktop widget editor", () => {
  it("places the compact Add Widget control after the grid without a sticky overlay", () => {
    render(
      <WidgetAddDock
        hiddenWidgetTypes={["network"]}
        hiddenCustomIds={[]}
        availableManifestIds={[]}
        onAdd={vi.fn()}
        inline
      />,
    );

    const addButton = screen.getByRole("button", { name: /Add Widget/ });
    expect(addButton.parentElement).toHaveClass("relative", "shrink-0", "justify-end");
    expect(addButton.parentElement).not.toHaveClass("sticky");
  });

  it("finishes editing from the persistent Done control while the picker is open", async () => {
    const onEditDoneRequested = vi.fn();
    render(
      <WidgetAddDock
        hiddenWidgetTypes={["network"]}
        hiddenCustomIds={[]}
        availableManifestIds={[]}
        onAdd={vi.fn()}
        onEditDoneRequested={onEditDoneRequested}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Add Widget/ }));
    expect(await screen.findByText("Add widget")).toBeVisible();

    const doneButton = document.createElement("button");
    doneButton.dataset.desktopWidgetEditDone = "";
    doneButton.textContent = "Done";
    document.body.append(doneButton);
    fireEvent.pointerDown(doneButton);

    expect(onEditDoneRequested).toHaveBeenCalledOnce();
    doneButton.remove();
  });
});
