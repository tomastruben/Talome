import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { SWRConfig } from "swr";
import type { AppBackupOverview, BackupSummary } from "@/app/dashboard/backups/_lib/types";

const { refreshUser, toastError } = vi.hoisted(() => ({ refreshUser: vi.fn(), toastError: vi.fn() }));

const userState = { isAdmin: false, isLoading: false, mutate: refreshUser };
vi.mock("@/hooks/use-user", () => ({ useUser: () => userState }));
vi.mock("sonner", () => ({ toast: { error: toastError, success: vi.fn() } }));
vi.mock("@/components/ai-elements/shimmer", () => ({
  Shimmer: ({ children }: { children: string }) => <span>{children}</span>,
}));

import BackupsPage from "@/app/dashboard/backups/page";
import { ADMIN_ONLY_MESSAGE } from "@/app/dashboard/backups/_lib/backup-status";

function backup(overrides: Partial<BackupSummary> = {}): BackupSummary {
  return {
    id: "b1",
    status: "completed",
    method: "stop",
    sizeBytes: 1024,
    startedAt: "2026-09-29T02:00:00.000Z",
    completedAt: "2026-09-29T02:01:00.000Z",
    verifyStatus: null,
    verifiedAt: null,
    purpose: "schedule",
    hasManifest: true,
    error: null,
    ...overrides,
  };
}

const APP: AppBackupOverview = {
  appId: "sonarr",
  name: "Sonarr",
  icon: null,
  iconUrl: null,
  appStatus: "running",
  config: { method: "auto", excludePatterns: [], includeVolumes: null, healthUrl: null },
  effectiveMethod: "stop",
  databases: [],
  scheduled: true,
  backupCount: 1,
  lastBackup: backup(),
  lastSuccessfulBackup: backup(),
  operation: null,
  running: false,
};

const fetchMock = vi.fn();

function renderPage() {
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <BackupsPage />
    </SWRConfig>,
  );
}

const mutations = () => fetchMock.mock.calls.filter(([, init]) => init?.method && init.method !== "GET");

beforeEach(() => {
  userState.isAdmin = false;
  userState.isLoading = false;
  refreshUser.mockClear();
  toastError.mockClear();
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      // What the server answers any non-admin change with.
      return new Response(JSON.stringify({ error: "Forbidden — admin access required" }), { status: 403 });
    }
    if (url.endsWith("/api/backups/apps")) return new Response(JSON.stringify([APP]), { status: 200 });
    return new Response(JSON.stringify([]), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Backups page access", () => {
  it("gives members a read-only status view without admin-only actions", async () => {
    renderPage();
    expect(await screen.findByText("Sonarr")).toBeInTheDocument();
    expect(screen.getByText(/of 1 apps backed up/)).toBeInTheDocument();

    expect(screen.queryByRole("button", { name: /Verify now/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Restore/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "More actions for Sonarr" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Storage/ })).not.toBeInTheDocument();
    expect(screen.getByText(/Only an admin can back up, verify or restore apps\./)).toBeInTheDocument();
    expect(mutations()).toHaveLength(0);
  });

  it("shows admins the backup actions", async () => {
    userState.isAdmin = true;
    renderPage();
    expect(await screen.findByText("Sonarr")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Verify now/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Restore/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "More actions for Sonarr" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Storage/ })).toBeInTheDocument();
    expect(screen.queryByText(/Only an admin can/)).not.toBeInTheDocument();
  });

  it("explains a 403 and re-reads the role when it still happens", async () => {
    // e.g. the role changed in another tab after this page loaded.
    userState.isAdmin = true;
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: /Verify now/ }));

    await waitFor(() => expect(toastError).toHaveBeenCalledWith(ADMIN_ONLY_MESSAGE));
    expect(refreshUser).toHaveBeenCalled();
  });
});

describe("Back up now", () => {
  it("is busy from the click and reports a failure that wrote no backup row (regression: no toast, fast polling forever)", async () => {
    userState.isAdmin = true;
    let resolveTrigger!: (res: Response) => void;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST" && url.endsWith("/api/backups/trigger")) {
        return new Promise<Response>((r) => { resolveTrigger = r; });
      }
      if (url.includes("/api/operations/op-9")) {
        return new Response(
          JSON.stringify({
            id: "op-9", appId: "sonarr", kind: "backup", actor: "user", status: "failed", step: "preparing", progress: 2,
            detail: null, error: "Could not resolve the app's compose file", startedAt: "2026-09-30T11:00:00.000Z",
            updatedAt: "2026-09-30T11:00:01.000Z", finishedAt: "2026-09-30T11:00:01.000Z",
          }),
          { status: 200 },
        );
      }
      // The operation ended at once: no running operation, no new backup row.
      if (url.endsWith("/api/backups/apps")) return new Response(JSON.stringify([APP]), { status: 200 });
      return new Response(JSON.stringify([]), { status: 200 });
    });
    renderPage();
    const button = await screen.findByRole("button", { name: /Back up now/ });
    fireEvent.click(button);
    // Busy before the server has answered.
    await waitFor(() => expect(screen.getByRole("button", { name: "Backing up Sonarr…" })).toHaveAttribute("aria-busy", "true"));

    resolveTrigger(new Response(JSON.stringify({ started: true, appId: "sonarr", operationId: "op-9" }), { status: 200 }));
    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith("Couldn't back up Sonarr", { description: "Could not resolve the app's compose file" }),
    );
    await waitFor(() => expect(screen.getByRole("button", { name: /Back up now/ })).not.toHaveAttribute("aria-busy"));
  });
});
