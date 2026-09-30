import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const replaceMock = vi.fn();
const refreshMock = vi.fn();
let search = "";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: replaceMock, refresh: refreshMock, push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(search),
}));

import LoginPage from "@/app/login/page";
import SetupPage from "@/app/setup/page";

const fetchMock = vi.fn();

function jsonResponse(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

describe("sign-in and setup integrity (P0-3)", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    replaceMock.mockReset();
    refreshMock.mockReset();
    search = "";
    vi.stubGlobal("fetch", fetchMock);
  });

  it("shows an error with Retry when the status probe fails, never the setup form", async () => {
    fetchMock
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(jsonResponse({ passwordConfigured: true }));
    render(<LoginPage />);

    expect(await screen.findByRole("heading", { name: "Can't reach Talome" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Create account" })).not.toBeInTheDocument();
    expect(replaceMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("heading", { name: "Welcome back" })).toBeInTheDocument();
  });

  it("treats a 5xx status answer as an error, not as 'no account'", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: "db" }, 503));
    render(<LoginPage />);
    expect(await screen.findByRole("heading", { name: "Can't reach Talome" })).toBeInTheDocument();
    expect(replaceMock).not.toHaveBeenCalledWith(expect.stringContaining("/setup"));
  });

  it("sends people to /setup only when the server says no account exists", async () => {
    search = "from=%2Fdashboard%2Ffiles";
    fetchMock.mockResolvedValueOnce(jsonResponse({ passwordConfigured: false }));
    render(<LoginPage />);
    await waitFor(() => expect(replaceMock).toHaveBeenCalledWith("/setup?from=%2Fdashboard%2Ffiles"));
  });

  it("requires an explicit username and never sends a default", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ passwordConfigured: true }));
    render(<LoginPage />);
    await screen.findByRole("heading", { name: "Welcome back" });

    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "secret-password" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByText("Enter your username.")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("ignores an off-site ?from= after signing in", async () => {
    search = "from=%2F%2Fevil.test";
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ passwordConfigured: true }))
      .mockResolvedValueOnce(jsonResponse({ ok: true, setup: false }));
    render(<LoginPage />);
    await screen.findByRole("heading", { name: "Welcome back" });

    fireEvent.change(screen.getByLabelText("Username"), { target: { value: "owner" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "secret-password" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() => expect(replaceMock).toHaveBeenCalledWith("/dashboard"));
    const [, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(fetchMock.mock.calls[1][0]).toBe("/api/auth/login");
    expect(JSON.parse(String(init.body))).toEqual({ username: "owner", password: "secret-password" });
  });

  it("setup posts to the setup endpoint, confirms the password and shows the recovery code", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ passwordConfigured: false }))
      .mockResolvedValueOnce(jsonResponse({ ok: true, username: "owner", recoveryCode: "7K3M-Q9TD-0A1B-C2D3-E4F5-G6H7" }));
    render(<SetupPage />);
    await screen.findByRole("heading", { name: "Set up Talome" });

    fireEvent.change(screen.getByLabelText("Username"), { target: { value: "owner" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "a-long-password" } });
    fireEvent.change(screen.getByLabelText("Confirm password"), { target: { value: "a-different-one" } });
    fireEvent.click(screen.getByRole("button", { name: "Create account" }));
    expect(await screen.findByText("The passwords don't match.")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fireEvent.change(screen.getByLabelText("Confirm password"), { target: { value: "a-long-password" } });
    fireEvent.click(screen.getByRole("button", { name: "Create account" }));
    expect(await screen.findByRole("heading", { name: "Save your recovery code" })).toBeInTheDocument();
    expect(fetchMock.mock.calls[1][0]).toBe("/api/auth/setup");

    fireEvent.change(screen.getByLabelText("Last group of the code"), { target: { value: "G6H7" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(replaceMock).toHaveBeenCalledWith("/dashboard");
  });

  it("announces a field error and moves focus to the field that needs fixing", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ passwordConfigured: false }));
    render(<SetupPage />);
    await screen.findByRole("heading", { name: "Set up Talome" });

    fireEvent.change(screen.getByLabelText("Username"), { target: { value: "owner" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "a-long-password" } });
    fireEvent.change(screen.getByLabelText("Confirm password"), { target: { value: "a-different-one" } });
    const submit = screen.getByRole("button", { name: "Create account" });
    submit.focus();
    fireEvent.click(submit);

    expect(await screen.findByRole("alert")).toHaveTextContent("The passwords don't match.");
    await waitFor(() => expect(screen.getByLabelText("Confirm password")).toHaveFocus());
  });

  it("sign-in focuses the username field when it's missing", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ passwordConfigured: true }));
    render(<LoginPage />);
    await screen.findByRole("heading", { name: "Welcome back" });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "secret-password" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Enter your username.");
    await waitFor(() => expect(screen.getByLabelText("Username")).toHaveFocus());
  });

  it("first-run setup uses the same sign-in frame as the login (wallpaper, glass card)", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ passwordConfigured: false }));
    const { container } = render(<SetupPage />);
    const heading = await screen.findByRole("heading", { name: "Set up Talome" });
    expect(heading.closest(".tm-glass-dense")).not.toBeNull();
    // The wallpaper backdrop (the device's stored wallpaper, or Talome's default).
    expect(container.querySelector("main img")).not.toBeNull();
  });

  it("setup sends people to sign in when an account already exists", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ passwordConfigured: true }));
    render(<SetupPage />);
    await waitFor(() => expect(replaceMock).toHaveBeenCalledWith("/login"));
  });
});
