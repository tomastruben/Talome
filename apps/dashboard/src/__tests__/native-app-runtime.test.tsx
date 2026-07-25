import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TalomeAppSpec } from "@talome/types";

const { push, requestDesktopNavigation } = vi.hoisted(() => ({
  push: vi.fn(),
  requestDesktopNavigation: vi.fn(() => true),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
}));

vi.mock("@/lib/desktop-navigation", () => ({
  requestDesktopNavigation,
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { NativeAppRuntime } from "@/components/native-app/native-app-runtime";
import { TalomeAreaTrend } from "@/components/native-app/talome-area-trend";

function appSpec(appId: string, dataSources: TalomeAppSpec["dataSources"]): TalomeAppSpec {
  return {
    schemaVersion: 1,
    revision: 1,
    appId,
    name: "Budget Compass",
    description: "A native budget tracker powered by Talome data and actions.",
    assistant: {
      context: "Help with the Budget Compass app.",
      suggestions: [{ label: "Review spending", prompt: "Review this month's spending." }],
      exposedActions: ["ask-budget"],
    },
    dataSources,
    actions: [{
      id: "ask-budget",
      label: "Ask about budget",
      description: "Open the Assistant with budget context.",
      kind: "assistant",
      prompt: "Review my budget.",
    }],
    surfaces: [{
      id: "overview",
      title: "Overview",
      layout: "dashboard",
      blocks: [
        {
          id: "remaining",
          title: "Remaining",
          component: "stat",
          dataSource: "snapshot",
          valuePath: "remaining",
          format: "currency",
          currency: "USD",
        },
        {
          id: "budget-progress",
          title: "Budget used",
          component: "progress",
          dataSource: "snapshot",
          valuePath: "spent",
          maxPath: "budget",
          valueFormat: "currency",
          currency: "CHF",
        },
        {
          id: "actions",
          title: "Actions",
          component: "actions",
          actionIds: ["ask-budget"],
        },
      ],
    }],
  };
}

function specResponse(spec: TalomeAppSpec) {
  return {
    appId: spec.appId,
    storeId: "user-apps",
    revision: spec.revision,
    status: "approved",
    spec,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  push.mockReset();
  requestDesktopNavigation.mockClear();
});

describe("NativeAppRuntime", () => {
  it("renders Talome-native blocks and hands context to the desktop Assistant", async () => {
    const spec = appSpec("budget-compass", [{
      id: "snapshot",
      kind: "static",
      value: { remaining: 1250, spent: 750, budget: 2000 },
    }]);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(specResponse(spec)), {
      status: 200,
      headers: { "content-type": "application/json" },
    })));

    render(<NativeAppRuntime storeId="user-apps" appId="budget-compass" />);

    expect(await screen.findByRole("heading", { name: "Budget Compass" })).toBeInTheDocument();
    expect(screen.getAllByText("$1,250.00").length).toBeGreaterThan(0);
    expect(screen.getByText("Remaining").closest('[data-slot="card"]')).toHaveClass("rounded-lg");
    expect(screen.getByRole("progressbar", { name: "Budget used: 38%" })).toBeInTheDocument();
    expect(screen.getByText("CHF 750.00 of CHF 2,000.00")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Ask Talome" }));
    expect(requestDesktopNavigation).toHaveBeenCalledOnce();
    const assistantHref = requestDesktopNavigation.mock.calls[0][0];
    expect(assistantHref).toContain("/dashboard/assistant?");
    expect(new URL(assistantHref, "http://talome.local").searchParams.get("prompt"))
      .toContain("Help with the Budget Compass app");
    expect(push).not.toHaveBeenCalled();
  });

  it("gives native charts an accessible name", () => {
    vi.stubGlobal("ResizeObserver", class implements ResizeObserver {
      constructor(private readonly callback: ResizeObserverCallback) {}
      observe(target: Element) {
        this.callback([{
          target,
          contentRect: { width: 800, height: 400 },
        } as ResizeObserverEntry], this);
      }
      unobserve() {}
      disconnect() {}
      takeRecords() { return []; }
    });

    render(
      <TalomeAreaTrend
        label="Cash flow"
        data={[
          { x: "01 Jul", balance: 6500 },
          { x: "02 Jul", balance: 4300 },
        ]}
        series={[{ id: "balance", label: "Available", valuePath: "balance" }]}
        valueFormat="currency"
        currency="CHF"
      />,
    );

    expect(screen.getByRole("application", { name: "Cash flow chart" })).toBeInTheDocument();
  });

  it("keeps healthy blocks usable when one independent data source fails", async () => {
    const spec = appSpec("budget-partial", [
      {
        id: "snapshot",
        kind: "static",
        value: { remaining: 900, spent: 100, budget: 1000 },
      },
      {
        id: "unreachable",
        kind: "talome-api",
        path: "/api/containers/missing",
      },
    ]);
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/data/unreachable")) {
        return new Response(JSON.stringify({ error: "Service is offline" }), {
          status: 503,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify(specResponse(spec)), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<NativeAppRuntime storeId="user-apps" appId="budget-partial" />);

    expect(await screen.findByText("Some app data is unavailable")).toBeInTheDocument();
    expect(screen.getByText("unreachable: Service is offline")).toBeInTheDocument();
    expect(screen.getAllByText("$900.00").length).toBeGreaterThan(0);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });

  it("renders the visual budget workspace from live AppSpec data without a Wi-Fi metaphor", async () => {
    vi.stubGlobal("ResizeObserver", class implements ResizeObserver {
      constructor(private readonly callback: ResizeObserverCallback) {}
      observe(target: Element) {
        this.callback([{
          target,
          contentRect: { width: 900, height: 400 },
        } as ResizeObserverEntry], this);
      }
      unobserve() {}
      disconnect() {}
      takeRecords() { return []; }
    });

    const spec: TalomeAppSpec = {
      schemaVersion: 1,
      revision: 4,
      appId: "budget-visual",
      name: "Budget Compass",
      description: "Your private household budget, understood by Talome.",
      icon: "money-saving-jar",
      assistant: {
        context: "Use recorded Budget Compass data.",
        suggestions: [],
        exposedActions: ["review-month"],
      },
      dataSources: [{
        id: "summary",
        kind: "static",
        value: {
          monthLabel: "July 2026",
          currency: "CHF",
          income: 6500,
          spent: 2694.15,
          available: 3805.85,
          budget: 4450,
          budgetRemaining: 1755.85,
          budgetUsage: 60.5,
          daysElapsed: 21,
          daysRemaining: 10,
          dailyPlanRemaining: 175.59,
          paceDelta: 7.2,
          paceLabel: "7.2 pts under monthly pace",
          projectedSpend: 3977.08,
          insight: {
            title: "Housing needs attention",
            body: "You have used 100% of the Housing plan with 10 days left.",
            tone: "watch",
          },
          categoryBudgets: [
            { category: "Housing", budget: 2200, spent: 2200, remaining: 0, usage: 100, status: "Watch" },
            { category: "Groceries", budget: 700, spent: 186.45, remaining: 513.55, usage: 26.6, status: "On track" },
          ],
          recentTransactions: [
            { id: "rent", date: "2026-07-02", dateLabel: "02 Jul", description: "Starter rent", category: "Housing", kind: "expense", amount: -2200 },
          ],
          spendingPace: [
            { date: "2026-07-01", dateLabel: "01 Jul", day: 1, actual: 0, plan: 143.55, projected: null },
            { date: "2026-07-21", dateLabel: "21 Jul", day: 21, actual: 2694.15, plan: 3014.52, projected: 2694.15 },
            { date: "2026-07-31", dateLabel: "31 Jul", day: 31, actual: null, plan: 4450, projected: 3977.08 },
          ],
        },
      }],
      actions: [{
        id: "review-month",
        label: "Review with Talome",
        description: "Review recorded spending.",
        kind: "assistant",
        prompt: "Review the current month.",
      }],
      surfaces: [{
        id: "overview",
        title: "Overview",
        layout: "dashboard",
        blocks: [{
          id: "budget-workspace",
          title: "Budget overview",
          component: "budget-overview",
          dataSource: "summary",
          currency: "CHF",
          reviewActionId: "review-month",
          span: 4,
        }],
      }],
    };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const body = String(input).includes("/actions/review-month")
        ? { ok: true, kind: "assistant", prompt: "Review the current month." }
        : specResponse(spec);
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }));

    render(<NativeAppRuntime storeId="user-apps" appId="budget-visual" />);

    expect(await screen.findByText("Left in your plan")).toBeInTheDocument();
    expect(screen.getAllByText("CHF 1,755.85").length).toBeGreaterThan(0);
    expect(screen.getByText("Available to spend")).toBeInTheDocument();
    expect(screen.getByText("CHF 175.59/day")).toBeInTheDocument();
    expect(screen.getByText("for 10 more days")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Budget used: 60.5%" })).toBeInTheDocument();
    expect(screen.getByRole("application", { name: "Spending pace chart" })).toBeInTheDocument();
    const moneyFlow = screen.getByRole("application", { name: "Monthly money flow chart" });
    expect(within(moneyFlow).getByText("Income")).toBeInTheDocument();
    expect(within(moneyFlow).getByText("Retained")).toBeInTheDocument();
    expect(screen.getByText("Talome noticed")).toBeInTheDocument();
    expect(screen.getByText("Housing needs attention")).toBeInTheDocument();
    expect(screen.queryByLabelText(/wi-?fi/i)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Review with Talome" }));
    await waitFor(() => expect(requestDesktopNavigation).toHaveBeenCalledOnce());
  });

  it("renders contextual primary actions and searchable native activity", async () => {
    const spec: TalomeAppSpec = {
      schemaVersion: 1,
      revision: 2,
      appId: "budget-premium",
      name: "Budget Compass",
      description: "Your private household budget, understood by Talome.",
      icon: "money-saving-jar",
      assistant: {
        context: "Help with the Budget Compass app.",
        suggestions: [],
        exposedActions: ["add-transaction", "set-budget"],
      },
      dataSources: [{
        id: "summary",
        kind: "static",
        value: {
          transactions: [
            { date: "2026-07-02", description: "Starter rent", category: "Housing", kind: "expense", amount: -2200 },
            { date: "2026-07-01", description: "Starter salary", category: "Income", kind: "income", amount: 6500 },
          ],
        },
      }],
      actions: [
        {
          id: "add-transaction",
          label: "Add transaction",
          description: "Record a transaction.",
          kind: "assistant",
          prompt: "Add a transaction.",
        },
        {
          id: "set-budget",
          label: "Set budget",
          description: "Adjust a category budget.",
          kind: "assistant",
          prompt: "Set a category budget.",
        },
      ],
      surfaces: [
        {
          id: "overview",
          title: "Overview",
          layout: "dashboard",
          primaryActionId: "set-budget",
          blocks: [{
            id: "activity-preview",
            title: "Recent transactions",
            component: "activity-list",
            dataSource: "summary",
            rowsPath: "transactions",
            datePath: "date",
            titlePath: "description",
            descriptionPath: "category",
            kindPath: "kind",
            valuePath: "amount",
            valueFormat: "currency",
            currency: "CHF",
            compact: true,
          }],
        },
        {
          id: "activity",
          title: "Activity",
          layout: "list",
          primaryActionId: "add-transaction",
          blocks: [{
            id: "activity-list",
            title: "Transactions",
            component: "activity-list",
            dataSource: "summary",
            rowsPath: "transactions",
            datePath: "date",
            titlePath: "description",
            descriptionPath: "category",
            kindPath: "kind",
            valuePath: "amount",
            valueFormat: "currency",
            currency: "CHF",
            searchPaths: ["description", "category"],
            filterPath: "kind",
            filters: [
              { label: "Income", value: "income" },
              { label: "Expenses", value: "expense" },
            ],
          }],
        },
      ],
    };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(specResponse(spec)), {
      status: 200,
      headers: { "content-type": "application/json" },
    })));

    render(<NativeAppRuntime storeId="user-apps" appId="budget-premium" />);

    expect(await screen.findByRole("button", { name: "Set budget" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "Activity" }));
    expect(screen.getByRole("button", { name: "Add transaction" })).toBeInTheDocument();

    fireEvent.change(screen.getByRole("searchbox", { name: "Search transactions" }), {
      target: { value: "salary" },
    });
    expect(screen.getByText("Starter salary")).toBeInTheDocument();
    expect(screen.queryByText("Starter rent")).not.toBeInTheDocument();

    fireEvent.change(screen.getByRole("searchbox", { name: "Search transactions" }), {
      target: { value: "" },
    });
    fireEvent.click(screen.getByRole("radio", { name: "Expenses" }));
    expect(screen.getByText("Starter rent")).toBeInTheDocument();
    expect(screen.queryByText("Starter salary")).not.toBeInTheDocument();
  });
});
