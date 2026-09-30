import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { UmbrelInstallDialog } from "@/components/app-detail/umbrel-install-dialog";
import { parseInstallPlan, type UmbrelInstallPlan } from "@/lib/umbrel-install";

function plan(raw: Record<string, unknown>): UmbrelInstallPlan {
  const parsed = parseInstallPlan({ plan: raw });
  if (!parsed) throw new Error("bad plan");
  return parsed;
}

describe("UmbrelInstallDialog", () => {
  it("shows the unsupported reason and disables install", () => {
    const onConfirm = vi.fn();
    render(
      <UmbrelInstallDialog
        open
        onOpenChange={() => {}}
        appName="Tor Thing"
        plan={plan({ supported: false, unsupportedReason: "This app is Tor-only.", blockers: ["This app is Tor-only."] })}
        onConfirm={onConfirm}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("This app is Tor-only.");
    expect(screen.getByRole("button", { name: "Install" })).toBeDisabled();
  });

  it("prefills folders and sends only changed choices", async () => {
    const onConfirm = vi.fn(async () => null);
    render(
      <UmbrelInstallDialog
        open
        onOpenChange={() => {}}
        appName="Immich"
        plan={plan({
          supported: true,
          folders: [
            {
              id: "uploads",
              name: "Uploads",
              mounts: [{ service: "server", targetPath: "/uploads" }],
              defaultSource: "/data/immich/uploads",
              source: "/data/immich/uploads",
            },
          ],
        })}
        onConfirm={onConfirm}
      />,
    );
    const input = screen.getByLabelText("Uploads") as HTMLInputElement;
    expect(input.value).toBe("/data/immich/uploads");

    fireEvent.click(screen.getByRole("button", { name: "Install" }));
    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith(undefined));

    fireEvent.change(input, { target: { value: "/mnt/photos" } });
    fireEvent.click(screen.getByRole("button", { name: "Install" }));
    await waitFor(() => expect(onConfirm).toHaveBeenLastCalledWith({ folders: { uploads: "/mnt/photos" } }));
  });

  it("blocks invalid folders and shows server blockers", async () => {
    const onConfirm = vi.fn(async () => ['Folder "Uploads": path is inside Talome\'s data directory.']);
    render(
      <UmbrelInstallDialog
        open
        onOpenChange={() => {}}
        appName="Immich"
        plan={plan({
          supported: true,
          folders: [{ id: "uploads", name: "Uploads", mounts: [], defaultSource: "/data/u", source: "/data/u" }],
        })}
        onConfirm={onConfirm}
      />,
    );
    const input = screen.getByLabelText("Uploads");
    fireEvent.change(input, { target: { value: "relative" } });
    fireEvent.click(screen.getByRole("button", { name: "Install" }));
    expect(await screen.findByText("Use an absolute path, e.g. /mnt/media")).toBeInTheDocument();
    expect(onConfirm).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: "/home/talome/.talome/x" } });
    fireEvent.click(screen.getByRole("button", { name: "Install" }));
    expect(await screen.findByText(/inside Talome's data directory/)).toBeInTheDocument();
  });
});
