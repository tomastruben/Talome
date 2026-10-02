import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const replaceMock = vi.fn();
const refreshMock = vi.fn();
let search = "";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: replaceMock, refresh: refreshMock, push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(search),
}));

// Reduced motion is read through useReducedMotion (MotionConfig doesn't stop
// opacity or style-bound motion), so the tests drive it directly.
const motionState = vi.hoisted(() => ({ reduced: false }));
vi.mock("motion/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("motion/react")>();
  return { ...actual, useReducedMotion: () => motionState.reduced };
});

import LoginPage from "@/app/login/page";
import SetupPage from "@/app/setup/page";
import { useUser } from "@/hooks/use-user";
import { LAST_USER_STORAGE_KEY } from "@/lib/sign-in";

const fetchMock = vi.fn();

function jsonResponse(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

/** A desktop-class device: a fine pointer that can hover (1024x768 in jsdom). */
function stubDesktopDevice(desktop = true) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: desktop && (query === "(any-hover: hover)" || query === "(any-pointer: fine)"),
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

function me(overrides: Record<string, unknown> = {}) {
  return {
    authenticated: true,
    userId: "u1",
    username: "owner",
    role: "admin",
    preferences: {},
    ...overrides,
  };
}

/** Views cross-fade: wait until the one on its way out has left. */
async function viewSettled(label: string) {
  await waitFor(() => expect(screen.getAllByLabelText(label)).toHaveLength(1));
}

/** Every value this origin keeps in browser storage, as one string. */
function everythingStored(): string {
  const values: string[] = [];
  for (const storage of [localStorage, sessionStorage]) {
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i)!;
      values.push(key, storage.getItem(key) ?? "");
    }
  }
  return values.join("\n");
}

beforeEach(() => {
  fetchMock.mockReset();
  replaceMock.mockReset();
  refreshMock.mockReset();
  search = "";
  motionState.reduced = false;
  localStorage.clear();
  sessionStorage.clear();
  vi.stubGlobal("fetch", fetchMock);
  stubDesktopDevice(false);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("sign-in and setup integrity (P0-3)", () => {
  it("shows an error with Retry when the status probe fails, never the setup form", async () => {
    fetchMock
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(jsonResponse({ passwordConfigured: true }));
    render(<LoginPage />);

    expect(await screen.findByRole("heading", { name: "Can't reach Talome" })).toBeInTheDocument();
    expect(screen.getByText(/Couldn't reach the Talome server/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Create account" })).not.toBeInTheDocument();
    expect(replaceMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("heading", { name: "Sign in to Talome" })).toBeInTheDocument();
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
    await screen.findByRole("heading", { name: "Sign in to Talome" });

    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "secret-password" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByText("Enter your username.")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("ignores an off-site ?from= after signing in", async () => {
    search = "from=%2F%2Fevil.test";
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ passwordConfigured: true }))
      .mockResolvedValueOnce(jsonResponse({ ok: true, setup: false }))
      .mockResolvedValueOnce(jsonResponse(me()));
    render(<LoginPage />);
    await screen.findByRole("heading", { name: "Sign in to Talome" });

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
      .mockResolvedValueOnce(jsonResponse({ ok: true, username: "owner", recoveryCode: "7K3M-Q9TD-0A1B-C2D3-E4F5-G6H7" }))
      .mockResolvedValueOnce(jsonResponse(me()));
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
    await waitFor(() => expect(replaceMock).toHaveBeenCalledWith("/dashboard"));
    // The owner is greeted by name at the next sign-in; the password is never kept.
    expect(localStorage.getItem(LAST_USER_STORAGE_KEY)).toBe("owner");
    expect(everythingStored()).not.toContain("a-long-password");
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
    await screen.findByRole("heading", { name: "Sign in to Talome" });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "secret-password" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Enter your username.");
    await waitFor(() => expect(screen.getByLabelText("Username")).toHaveFocus());
    expect(screen.getByLabelText("Username")).toHaveAttribute("aria-invalid", "true");
  });

  it("first-run setup keeps a compact glass panel on the same wallpaper as sign-in", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ passwordConfigured: false }));
    const { container } = render(<SetupPage />);
    const heading = await screen.findByRole("heading", { name: "Set up Talome" });
    expect(heading.closest(".tm-glass-dense")).not.toBeNull();
    // The wallpaper backdrop (the device's stored wallpaper, or Talome's default).
    expect(container.querySelector("main img")).not.toBeNull();
    // The privacy line lives here, at account creation, as a quiet hint.
    expect(screen.getByText("Your data stays on your server.")).toHaveClass("text-xs");
  });

  it("setup sends people to sign in when an account already exists", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ passwordConfigured: true }));
    render(<SetupPage />);
    await waitFor(() => expect(replaceMock).toHaveBeenCalledWith("/login"));
  });
});

describe("the lock screen", () => {
  it("has no card: the fields sit on the wallpaper, under a large clock", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ passwordConfigured: true }));
    const { container } = render(<LoginPage />);
    const heading = await screen.findByRole("heading", { name: "Sign in to Talome" });
    // The h1 is for screen readers; nothing on screen repeats it.
    expect(heading).toHaveClass("sr-only");
    expect(container.querySelector(".rounded-2xl.tm-glass-dense")).toBeNull();
    expect(screen.queryByText("Welcome back")).not.toBeInTheDocument();
    expect(screen.queryByText("Your data stays on your server.")).not.toBeInTheDocument();
    // The clock: large, regular weight, tabular, on the scrim halo.
    const clock = container.querySelector(".text-6xl");
    expect(clock).toHaveClass("font-normal", "tracking-tight", "tabular-nums");
    expect(clock?.closest(".tm-on-scrim")).not.toBeNull();
    expect(container.querySelector("main img")).not.toBeNull();
  });

  it("offers a username and a password pill when this browser remembers nobody", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ passwordConfigured: true }));
    render(<LoginPage />);
    await screen.findByRole("heading", { name: "Sign in to Talome" });

    const usernameField = screen.getByLabelText("Username");
    expect(usernameField).toHaveAttribute("autocomplete", "username");
    expect(usernameField).toHaveAttribute("name", "username");
    expect(usernameField).toHaveFocus();
    const passwordField = screen.getByLabelText("Password");
    expect(passwordField).toHaveAttribute("type", "password");
    expect(passwordField).toHaveAttribute("autocomplete", "current-password");
    expect(screen.getByRole("button", { name: "Forgot password?" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Sign in as/ })).not.toBeInTheDocument();
  });

  it("greets the remembered person: avatar, name and one password pill", async () => {
    localStorage.setItem(LAST_USER_STORAGE_KEY, "tomas");
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ passwordConfigured: true }))
      .mockResolvedValueOnce(jsonResponse({ ok: true, setup: false }))
      .mockResolvedValueOnce(jsonResponse(me({ username: "tomas" })));
    const { container } = render(<LoginPage />);
    await screen.findByRole("heading", { name: "Sign in to Talome" });

    expect(screen.getByText("tomas")).toHaveClass("text-base", "font-medium");
    // The avatar is decorative: the initial on glass, hidden from screen readers.
    const avatar = screen.getByText("T").closest(".tm-glass-dense");
    expect(avatar).toHaveAttribute("aria-hidden", "true");
    expect(avatar).toHaveClass("size-16", "rounded-full");
    // One visible field; the username rides along for password managers.
    expect(screen.queryByLabelText("Username")).not.toBeInTheDocument();
    const hiddenUsername = container.querySelector('input[name="username"]');
    expect(hiddenUsername).toHaveAttribute("autocomplete", "username");
    expect(hiddenUsername).toHaveValue("tomas");
    expect(hiddenUsername).not.toBeVisible();
    const passwordField = screen.getByLabelText("Password");
    expect(passwordField).toHaveAttribute("placeholder", "Enter password");
    expect(passwordField).toHaveFocus();

    fireEvent.change(passwordField, { target: { value: "secret-password" } });
    fireEvent.submit(passwordField.closest("form")!);
    await waitFor(() => expect(replaceMock).toHaveBeenCalledWith("/dashboard"));
    const [, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ username: "tomas", password: "secret-password" });
  });

  it("signs in as someone else without forgetting anyone until they succeed", async () => {
    localStorage.setItem(LAST_USER_STORAGE_KEY, "tomas");
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ passwordConfigured: true }))
      .mockResolvedValueOnce(jsonResponse({ error: "That username and password don't match. Check both, or reset your password." }, 401))
      .mockResolvedValueOnce(jsonResponse({ ok: true, setup: false }))
      .mockResolvedValueOnce(jsonResponse(me({ userId: "u2", username: "guest", role: "member" })));
    render(<LoginPage />);
    await screen.findByText("tomas");

    fireEvent.click(screen.getByRole("button", { name: "Sign in as someone else" }));
    const usernameField = await screen.findByLabelText("Username");
    await waitFor(() => expect(usernameField).toHaveFocus());
    await viewSettled("Password");
    expect(screen.getByRole("button", { name: "Sign in as tomas" })).toBeInTheDocument();
    expect(localStorage.getItem(LAST_USER_STORAGE_KEY)).toBe("tomas");

    // The fields still answer to focus after the cross-fade (the leaving view's
    // field must not take the page's handle on the new one with it).
    fireEvent.change(usernameField, { target: { value: "guest" } });
    fireEvent.submit(usernameField.closest("form")!);
    expect(await screen.findByRole("alert")).toHaveTextContent("Enter your password.");
    await waitFor(() => expect(screen.getByLabelText("Password")).toHaveFocus());

    // A refused attempt leaves the remembered person alone.
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "wrong-password" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("don't match");
    expect(localStorage.getItem(LAST_USER_STORAGE_KEY)).toBe("tomas");

    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "right-password" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(replaceMock).toHaveBeenCalledWith("/dashboard"));
    expect(JSON.parse(String((fetchMock.mock.calls[2] as [string, RequestInit])[1].body))).toEqual({
      username: "guest",
      password: "right-password",
    });
    expect(localStorage.getItem(LAST_USER_STORAGE_KEY)).toBe("guest");
  });

  it("goes back to the remembered person", async () => {
    localStorage.setItem(LAST_USER_STORAGE_KEY, "tomas");
    fetchMock.mockResolvedValueOnce(jsonResponse({ passwordConfigured: true }));
    render(<LoginPage />);
    await screen.findByText("tomas");
    fireEvent.click(screen.getByRole("button", { name: "Sign in as someone else" }));
    fireEvent.click(await screen.findByRole("button", { name: "Sign in as tomas" }));
    await waitFor(() => expect(screen.queryByLabelText("Username")).not.toBeInTheDocument());
    expect(await screen.findByText("tomas")).toBeInTheDocument();
    expect(screen.getByLabelText("Password")).toHaveAttribute("placeholder", "Enter password");
  });

  it("keeps only the username: never the password, anywhere in browser storage", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ passwordConfigured: true }))
      .mockResolvedValueOnce(jsonResponse({ ok: true, setup: false }))
      .mockResolvedValueOnce(jsonResponse(me()));
    render(<LoginPage />);
    await screen.findByRole("heading", { name: "Sign in to Talome" });
    fireEvent.change(screen.getByLabelText("Username"), { target: { value: "  owner " } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "hunter2-hunter2" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(replaceMock).toHaveBeenCalled());

    expect(localStorage.getItem(LAST_USER_STORAGE_KEY)).toBe("owner");
    expect(everythingStored()).not.toContain("hunter2");
  });

  it("works when browser storage is unavailable", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("denied", "SecurityError");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("denied", "SecurityError");
    });
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ passwordConfigured: true }))
      .mockResolvedValueOnce(jsonResponse({ ok: true, setup: false }))
      .mockResolvedValueOnce(jsonResponse(me()));
    render(<LoginPage />);
    await screen.findByRole("heading", { name: "Sign in to Talome" });
    fireEvent.change(screen.getByLabelText("Username"), { target: { value: "owner" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "secret-password" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(replaceMock).toHaveBeenCalledWith("/dashboard"));
  });

  it("names every control for screen readers", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ passwordConfigured: true }));
    render(<LoginPage />);
    await screen.findByRole("heading", { level: 1, name: "Sign in to Talome" });

    const submit = screen.getByRole("button", { name: "Sign in" });
    expect(submit).toHaveAttribute("type", "submit");
    // Never disabled (Enter always submits); it shows once there's a password.
    expect(submit).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Show password" })).not.toBeInTheDocument();

    const passwordField = screen.getByLabelText("Password");
    fireEvent.change(passwordField, { target: { value: "secret" } });
    const reveal = screen.getByRole("button", { name: "Show password" });
    expect(reveal).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(reveal);
    expect(reveal).toHaveAttribute("aria-pressed", "true");
    expect(passwordField).toHaveAttribute("type", "text");
    // Both pills sit in one form, so Enter submits from either.
    expect(screen.getByLabelText("Username").closest("form")).toBe(passwordField.closest("form"));
  });

  it("asks for the password instead of sending an empty one", async () => {
    localStorage.setItem(LAST_USER_STORAGE_KEY, "tomas");
    fetchMock.mockResolvedValueOnce(jsonResponse({ passwordConfigured: true }));
    render(<LoginPage />);
    await screen.findByText("tomas");
    const passwordField = screen.getByLabelText("Password");
    fireEvent.submit(passwordField.closest("form")!);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Enter your password.");
    expect(passwordField).toHaveFocus();
    expect(passwordField).toHaveAttribute("aria-describedby", alert.id);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("sends what a password manager filled in, even before React saw it", async () => {
    localStorage.setItem(LAST_USER_STORAGE_KEY, "tomas");
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ passwordConfigured: true }))
      .mockResolvedValueOnce(jsonResponse({ ok: true, setup: false }))
      .mockResolvedValueOnce(jsonResponse(me({ username: "tomas" })));
    render(<LoginPage />);
    await screen.findByText("tomas");
    const passwordField = screen.getByLabelText("Password") as HTMLInputElement;
    // Set the DOM value without an input event, like a fill the page wasn't told about.
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(passwordField, "filled-by-manager");
    fireEvent.submit(passwordField.closest("form")!);
    await waitFor(() => expect(replaceMock).toHaveBeenCalledWith("/dashboard"));
    expect(JSON.parse(String((fetchMock.mock.calls[1] as [string, RequestInit])[1].body))).toEqual({
      username: "tomas",
      password: "filled-by-manager",
    });
  });

  it("a network failure is explained, but doesn't mark the password wrong", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ passwordConfigured: true }))
      .mockRejectedValueOnce(new TypeError("Failed to fetch"));
    render(<LoginPage />);
    await screen.findByRole("heading", { name: "Sign in to Talome" });
    fireEvent.change(screen.getByLabelText("Username"), { target: { value: "owner" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "secret" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't reach the Talome server.");
    expect(screen.getByLabelText("Password")).not.toHaveAttribute("aria-invalid");
  });

  it("shakes and explains a refused attempt, linked to the password field", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ passwordConfigured: true }))
      .mockResolvedValueOnce(jsonResponse({ error: "That username and password don't match. Check both, or reset your password." }, 401));
    render(<LoginPage />);
    await screen.findByRole("heading", { name: "Sign in to Talome" });
    fireEvent.change(screen.getByLabelText("Username"), { target: { value: "owner" } });
    const passwordField = screen.getByLabelText("Password");
    fireEvent.change(passwordField, { target: { value: "wrong" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("That username and password don't match.");
    // Text-sm on the scrim: foreground with the halo, the icon carries the colour.
    expect(alert).toHaveClass("text-sm", "tm-on-scrim", "text-foreground");
    expect(passwordField).toHaveAttribute("aria-invalid", "true");
    expect(passwordField).toHaveAttribute("aria-describedby", alert.id);
    expect(passwordField.closest(".tm-shake")).not.toBeNull();
    expect(replaceMock).not.toHaveBeenCalled();
  });

  it("says how long to wait when sign-in is rate limited", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ passwordConfigured: true }))
      .mockResolvedValueOnce(jsonResponse({ error: "Too many requests", retryAfter: 42 }, 429));
    render(<LoginPage />);
    await screen.findByRole("heading", { name: "Sign in to Talome" });
    fireEvent.change(screen.getByLabelText("Username"), { target: { value: "owner" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "secret" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Too many attempts. Wait 42 seconds, then try again.");
  });

  it("opens the reset with the remembered username filled in, and comes back", async () => {
    localStorage.setItem(LAST_USER_STORAGE_KEY, "tomas");
    fetchMock.mockResolvedValueOnce(jsonResponse({ passwordConfigured: true }));
    render(<LoginPage />);
    await screen.findByText("tomas");
    fireEvent.click(screen.getByRole("button", { name: "Forgot password?" }));
    const heading = await screen.findByRole("heading", { name: "Reset password" });
    // The reset keeps a compact glass panel.
    expect(heading.closest(".tm-glass-dense")).not.toBeNull();
    expect(screen.getByLabelText("Username")).toHaveValue("tomas");
    fireEvent.click(screen.getByRole("button", { name: "Back to sign in" }));
    expect(await screen.findByText("tomas")).toBeInTheDocument();
  });

  it("keeps the recovery-code flow: reset, save the new code, then continue signed in", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ passwordConfigured: true }))
      .mockResolvedValueOnce(jsonResponse({ ok: true, newRecoveryCode: "AAAA-BBBB-CCCC-DDDD-EEEE-FFFF" }))
      .mockResolvedValueOnce(jsonResponse(me({ username: "owner" })));
    render(<LoginPage />);
    await screen.findByRole("heading", { name: "Sign in to Talome" });
    fireEvent.click(screen.getByRole("button", { name: "Forgot password?" }));
    await screen.findByRole("heading", { name: "Reset password" });
    await viewSettled("Username");
    fireEvent.change(screen.getByLabelText("Username"), { target: { value: "owner" } });
    fireEvent.change(screen.getByLabelText("Recovery code"), { target: { value: "1111-2222-3333-4444-5555-6666" } });
    fireEvent.change(screen.getByLabelText("New password"), { target: { value: "a-new-password" } });
    fireEvent.change(screen.getByLabelText("Confirm new password"), { target: { value: "a-new-password" } });
    fireEvent.click(screen.getByRole("button", { name: "Reset password" }));
    expect(await screen.findByRole("heading", { name: "Save your new recovery code" })).toBeInTheDocument();
    expect(fetchMock.mock.calls[1][0]).toBe("/api/auth/recover");

    fireEvent.change(screen.getByLabelText("Last group of the code"), { target: { value: "FFFF" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(replaceMock).toHaveBeenCalledWith("/dashboard"));
    expect(localStorage.getItem(LAST_USER_STORAGE_KEY)).toBe("owner");
    expect(everythingStored()).not.toContain("a-new-password");
  });
});

describe("after signing in", () => {
  async function signIn(meBody: unknown) {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ passwordConfigured: true }))
      .mockResolvedValueOnce(jsonResponse({ ok: true, setup: false }))
      .mockResolvedValueOnce(jsonResponse(meBody));
    const view = render(<LoginPage />);
    await screen.findByRole("heading", { name: "Sign in to Talome" });
    fireEvent.change(screen.getByLabelText("Username"), { target: { value: "owner" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "secret-password" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    return view;
  }

  it("opens the desktop directly for someone who uses it, never the classic dashboard first", async () => {
    stubDesktopDevice(true);
    await signIn(me({ preferences: { desktopMode: "desktop" } }));
    await waitFor(() => expect(replaceMock).toHaveBeenCalledWith("/dashboard/desktop"));
    expect(replaceMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[2][0]).toBe("/api/auth/me");
  });

  it("keeps a deep link: ?from= elsewhere wins over the desktop", async () => {
    stubDesktopDevice(true);
    search = "from=%2Fdashboard%2Ffiles%3Fpath%3D%252Fmedia";
    await signIn(me({ preferences: { desktopMode: "desktop" } }));
    await waitFor(() => expect(replaceMock).toHaveBeenCalledWith("/dashboard/files?path=%2Fmedia"));
  });

  it("opens the classic dashboard on a device that can't show the desktop", async () => {
    stubDesktopDevice(false);
    await signIn(me({ preferences: { desktopMode: "desktop" } }));
    await waitFor(() => expect(replaceMock).toHaveBeenCalledWith("/dashboard"));
  });

  it("hands the signed-in user to the dashboard, so it opens without a loading step", async () => {
    stubDesktopDevice(true);
    await signIn(me({ username: "primed-owner", preferences: { desktopMode: "desktop" } }));
    await waitFor(() => expect(replaceMock).toHaveBeenCalled());

    function Probe() {
      const { user, isLoading } = useUser();
      return <p>{isLoading ? "loading" : user?.username}</p>;
    }
    fetchMock.mockResolvedValue(jsonResponse(me({ username: "primed-owner" })));
    render(<Probe />);
    // On the very first render: no "loading" step in between.
    expect(screen.getByText("primed-owner")).toBeInTheDocument();
  });

  it("unlocks: the scrim fades so the wallpaper sharpens, and the wallpaper stays put for the hand-over", async () => {
    stubDesktopDevice(true);
    const { container } = await signIn(me({ preferences: { desktopMode: "desktop" } }));
    const scrim = container.querySelector("[data-lock-scrim]")!;
    await waitFor(() => expect(scrim).toHaveClass("opacity-0"));
    const wallpaper = container.querySelector("main img") as HTMLImageElement;
    fireEvent.load(wallpaper);
    expect(wallpaper.style.transform).toBe("scale(1)");
    await waitFor(() => expect(replaceMock).toHaveBeenCalledWith("/dashboard/desktop"));
  });

  it("under reduced motion the unlock is a short fade: no zoom on the wallpaper", async () => {
    motionState.reduced = true;
    stubDesktopDevice(true);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { container } = await signIn(me({ preferences: { desktopMode: "desktop" } }));
      const wallpaper = container.querySelector("main img") as HTMLImageElement;
      expect(wallpaper.style.transform).toBe("scale(1)");
      expect(wallpaper.style.transition).not.toContain("transform");
      await waitFor(() => expect(container.querySelector("[data-lock-scrim]")).toHaveClass("opacity-0"));
      // The 120ms fade, then the desktop.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(130);
      });
      expect(replaceMock).toHaveBeenCalledWith("/dashboard/desktop");
    } finally {
      vi.useRealTimers();
    }
  });

  it("the sign-in arrow reports the unlock while it plays", async () => {
    stubDesktopDevice(true);
    await signIn(me({ preferences: { desktopMode: "desktop" } }));
    const form = screen.getByLabelText("Password").closest("form")!;
    await waitFor(() => expect(within(form).getByRole("button", { name: "Opening Talome…" })).toHaveAttribute("aria-busy", "true"));
  });
});
