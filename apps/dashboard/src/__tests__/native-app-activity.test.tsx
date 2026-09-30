import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { TalomeActivityListBlock } from "@talome/types";
import { ActivityListBlock } from "@/components/native-app/native-app-premium-blocks";

const block: TalomeActivityListBlock = {
  id: "incidents", title: "Incidents", component: "activity-list", icon: "activity",
  dataSource: "history", rowsPath: "incidents", datePath: "timestamp", titlePath: "type",
  descriptionPath: "description", valuePath: "severity", valueFormat: "text",
  searchPaths: ["type", "description"], filterPath: "severity",
  filters: [{ label: "High", value: "high" }, { label: "Low", value: "low" }],
};
const data = { history: { incidents: [
  { timestamp: "2026-09-06T10:00:00Z", type: "cpu_spike", description: "CPU exceeded its threshold", severity: "high" },
  { timestamp: "2026-09-06T09:00:00Z", type: "disk_io", description: "Disk latency increased", severity: "low" },
] } };

describe("domain-specific native activity", () => {
  it("searches and filters incident records using domain labels", () => {
    render(<ActivityListBlock block={block} data={data} actions={[]} onAction={vi.fn()} />);
    const search = screen.getByRole("searchbox", { name: "Search incidents" });
    expect(screen.queryByText(/transactions/i)).not.toBeInTheDocument();
    fireEvent.change(search, { target: { value: "CPU" } });
    expect(screen.getByText("cpu_spike")).toBeVisible();
    expect(screen.queryByText("disk_io")).not.toBeInTheDocument();
    fireEvent.change(search, { target: { value: "" } });
    fireEvent.click(screen.getByRole("radio", { name: "Low" }));
    expect(screen.getByText("disk_io")).toBeVisible();
    expect(screen.queryByText("cpu_spike")).not.toBeInTheDocument();
    fireEvent.change(search, { target: { value: "no-match" } });
    expect(screen.getByText("No incidents match these filters.")).toBeVisible();
  });

  it("shows a domain empty state without inventing records", () => {
    render(<ActivityListBlock block={block} data={{ history: { incidents: [] } }} actions={[]} onAction={vi.fn()} />);
    expect(screen.getByText("No incidents yet.")).toBeVisible();
  });
});
