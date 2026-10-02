import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DESKTOP_PATH,
  LAST_USER_STORAGE_KEY,
  isDashboardHome,
  preferredDashboardMode,
  readRememberedUser,
  rememberUser,
  resolveSignInDestination,
  signInDestination,
  userInitial,
} from "@/lib/sign-in";
import { lockClockParts } from "@/components/trust/auth-shell";

function stubDevice(desktop: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: desktop && (query === "(any-hover: hover)" || query === "(any-pointer: fine)"),
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
}

function response(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("signInDestination", () => {
  const desktop = { mode: "desktop" as const, desktopAvailable: true, canOpenHome: true };

  it("sends the dashboard home to the desktop for someone who uses it", () => {
    expect(signInDestination({ returnTo: "/dashboard", ...desktop })).toBe(DESKTOP_PATH);
    expect(signInDestination({ returnTo: "/", ...desktop })).toBe(DESKTOP_PATH);
    expect(signInDestination({ returnTo: "/dashboard/", ...desktop })).toBe(DESKTOP_PATH);
    expect(signInDestination({ returnTo: "/dashboard?preview=fresh", ...desktop })).toBe(DESKTOP_PATH);
  });

  it("keeps an explicit deep link", () => {
    expect(signInDestination({ returnTo: "/dashboard/files?path=%2Fmedia", ...desktop })).toBe("/dashboard/files?path=%2Fmedia");
    expect(signInDestination({ returnTo: "/dashboard/settings/approvals?id=a1", ...desktop })).toBe("/dashboard/settings/approvals?id=a1");
    expect(signInDestination({ returnTo: "/dashboardx", ...desktop })).toBe("/dashboardx");
    expect(signInDestination({ returnTo: DESKTOP_PATH, ...desktop })).toBe(DESKTOP_PATH);
  });

  it("stays classic when the mode, the device or the home says so", () => {
    expect(signInDestination({ ...desktop, returnTo: "/dashboard", mode: "classic" })).toBe("/dashboard");
    expect(signInDestination({ ...desktop, returnTo: "/dashboard", mode: undefined })).toBe("/dashboard");
    expect(signInDestination({ ...desktop, returnTo: "/dashboard", desktopAvailable: false })).toBe("/dashboard");
    // A member who can't open the home is sent to their first app by the shell, as before.
    expect(signInDestination({ ...desktop, returnTo: "/dashboard", canOpenHome: false })).toBe("/dashboard");
  });

  it("recognises the dashboard home only", () => {
    expect(isDashboardHome("/")).toBe(true);
    expect(isDashboardHome("/dashboard#top")).toBe(true);
    expect(isDashboardHome("/dashboard/apps")).toBe(false);
    expect(isDashboardHome("/dashboards")).toBe(false);
  });
});

describe("preferredDashboardMode", () => {
  it("prefers this device's choice over the account's, like the dashboard home", () => {
    localStorage.setItem("talome:dashboard-mode:v1:u1", "classic");
    expect(preferredDashboardMode({ authenticated: true, userId: "u1", preferences: { desktopMode: "desktop" } })).toBe("classic");
    expect(preferredDashboardMode({ authenticated: true, userId: "u2", preferences: { desktopMode: "desktop" } })).toBe("desktop");
    expect(preferredDashboardMode({ authenticated: false, userId: "u2", preferences: { desktopMode: "desktop" } })).toBeUndefined();
  });
});

describe("resolveSignInDestination", () => {
  it("reads the new session and opens the desktop", async () => {
    stubDevice(true);
    const fetchMock = vi.fn().mockResolvedValue(response({ authenticated: true, userId: "u1", username: "owner", role: "admin", preferences: { desktopMode: "desktop" } }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await resolveSignInDestination("/dashboard");
    expect(result.path).toBe(DESKTOP_PATH);
    expect(result.user?.username).toBe("owner");
    expect(fetchMock).toHaveBeenCalledWith("/api/auth/me", expect.objectContaining({ credentials: "include", cache: "no-store" }));
  });

  it("leaves a member without the dashboard on the home, where the shell routes them", async () => {
    stubDevice(true);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({
      authenticated: true,
      userId: "u3",
      role: "member",
      permissions: { dashboard: false },
      preferences: { desktopMode: "desktop" },
    })));
    expect((await resolveSignInDestination("/dashboard")).path).toBe("/dashboard");
  });

  it("never opens a desktop inside a desktop window", async () => {
    stubDevice(true);
    vi.spyOn(window, "top", "get").mockReturnValue({} as Window);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({ authenticated: true, userId: "u1", role: "admin", preferences: { desktopMode: "desktop" } })));
    expect((await resolveSignInDestination("/dashboard")).path).toBe("/dashboard");
  });

  it("falls back to the return path when the session can't be read", async () => {
    stubDevice(true);
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    expect(await resolveSignInDestination("/dashboard")).toEqual({ path: "/dashboard", user: null });

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({ error: "boom" }, 500)));
    expect(await resolveSignInDestination("/dashboard")).toEqual({ path: "/dashboard", user: null });

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({ authenticated: false })));
    expect(await resolveSignInDestination("/dashboard")).toEqual({ path: "/dashboard", user: null });
  });

  it("gives up on a slow answer rather than holding the unlock", async () => {
    stubDevice(true);
    vi.stubGlobal("fetch", vi.fn((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    })));
    expect(await resolveSignInDestination("/dashboard", { timeoutMs: 10 })).toEqual({ path: "/dashboard", user: null });
  });
});

describe("the remembered user", () => {
  it("stores the trimmed username under one key, and nothing else", () => {
    expect(rememberUser("  tomas  ")).toBe(true);
    expect(localStorage.getItem(LAST_USER_STORAGE_KEY)).toBe("tomas");
    expect(localStorage.length).toBe(1);
    expect(readRememberedUser()).toBe("tomas");
  });

  it("ignores empty, oversized or control-character names", () => {
    expect(rememberUser("   ")).toBe(false);
    expect(rememberUser("a".repeat(101))).toBe(false);
    expect(rememberUser("bad\nname")).toBe(false);
    expect(readRememberedUser()).toBeNull();
    localStorage.setItem(LAST_USER_STORAGE_KEY, "x\u0000y");
    expect(readRememberedUser()).toBeNull();
  });

  it("copes with storage that throws", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("denied"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("denied"); });
    expect(readRememberedUser()).toBeNull();
    expect(rememberUser("tomas")).toBe(false);
  });

  it("draws the initial a person would write", () => {
    expect(userInitial("tomas")).toBe("T");
    expect(userInitial("  ölaf")).toBe("Ö");
    expect(userInitial("👩‍💻dev")).toBe("👩‍💻");
    expect(userInitial("")).toBe("");
  });
});

describe("the lock clock", () => {
  it("shows hours and minutes large, and keeps AM/PM for screen readers", () => {
    const evening = new Date(2026, 9, 2, 21, 41);
    const { short, spoken, date } = lockClockParts(evening);
    expect(short).toMatch(/41/);
    expect(short).not.toMatch(/AM|PM/i);
    expect(spoken).toContain(short);
    expect(date.length).toBeGreaterThan(0);
  });
});
