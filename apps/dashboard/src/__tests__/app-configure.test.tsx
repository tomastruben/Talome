import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ConfigurePage from "@/app/dashboard/apps/[storeId]/[appId]/configure/page";

const mocks = vi.hoisted(() => ({ state: {} as Record<string, unknown>, mutate: vi.fn(), fetch: vi.fn() }));
vi.mock("next/navigation", () => ({ useParams: () => ({ appId: "example", storeId: "user-apps" }) }));
vi.mock("swr", () => ({ default: () => ({ ...mocks.state, mutate: mocks.mutate }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", mocks.fetch);
  mocks.fetch.mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
  mocks.state = { data: { appId: "example", composePath: "/app/compose.yml", config: { services: { web: {
    environment: ["TOKEN=a=b==", "NAME=before", "INHERITED"],
    ports: ["127.0.0.1:8080:80/tcp", { target: 53, published: 5353, protocol: "udp" }],
  } } } } };
});

describe("app configuration flow", () => {
  it("sends the selected service and exact mapping when saving a port", async () => {
    render(<ConfigurePage />);
    fireEvent.click(screen.getByRole("button", { name: "Edit ports" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Host port for 80/tcp on 127.0.0.1" }), { target: { value: "8081" } });
    fireEvent.click(screen.getByRole("button", { name: "Save ports" }));
    await waitFor(() => expect(mocks.fetch).toHaveBeenCalled());
    expect(JSON.parse(mocks.fetch.mock.calls[0][1].body)).toEqual({ serviceName: "web", portMappings: [{ index: 0, published: 8081 }] });
    await waitFor(() => expect(screen.getByRole("button", { name: "Edit ports" })).toBeVisible());
  });

  it("keeps invalid port input visible and prevents submission", () => {
    render(<ConfigurePage />);
    fireEvent.click(screen.getByRole("button", { name: "Edit ports" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Host port for 53/udp" }), { target: { value: "70000" } });
    fireEvent.click(screen.getByRole("button", { name: "Save ports" }));
    expect(screen.getByRole("alert")).toHaveTextContent("1 to 65535");
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("preserves complete environment values and only submits changed keys", async () => {
    render(<ConfigurePage />);
    expect(screen.getByLabelText("TOKEN")).toHaveValue("a=b==");
    expect(screen.getByLabelText("INHERITED")).toHaveAttribute("placeholder", "Inherited from host");
    fireEvent.change(screen.getByLabelText("NAME"), { target: { value: "after" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(mocks.fetch).toHaveBeenCalled());
    expect(JSON.parse(mocks.fetch.mock.calls[0][1].body)).toEqual({ serviceName: "web", env: { NAME: "after" } });
  });

  it("surfaces server errors and offers a retry", () => {
    mocks.state = { error: new Error("App configuration is missing") };
    render(<ConfigurePage />);
    expect(screen.getByRole("alert")).toHaveTextContent("App configuration is missing");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(mocks.mutate).toHaveBeenCalled();
  });
});
