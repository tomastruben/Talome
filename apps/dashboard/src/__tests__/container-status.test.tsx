import { readFileSync } from "node:fs";
import { join } from "node:path";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { Container, ServiceStack } from "@talome/types";

import { ContainerCard } from "@/components/dashboard/container-card";
import { CONTAINER_HEALTH_DOT_CLASS, containerHealth, stackHealth } from "@/lib/container-status";

function container(status: Container["status"], extra: Partial<Container> & { exitCode?: number } = {}): Container {
  return {
    id: `c-${status}`,
    name: `app-${status}`,
    image: "example/app:1.0",
    status,
    ports: [],
    created: "2026-09-30T00:00:00.000Z",
    labels: {},
    ...extra,
  };
}

function stack(status: ServiceStack["status"], containers: Container[]): Pick<ServiceStack, "status" | "containers"> {
  return { status, containers };
}

describe("containerHealth", () => {
  it("shows a crash-loop (Docker `restarting`) as needing attention, never as work in flight", () => {
    expect(containerHealth(container("restarting"))).toBe("attention");
    expect(CONTAINER_HEALTH_DOT_CLASS.attention).toContain("bg-status-warning");
    expect(CONTAINER_HEALTH_DOT_CLASS.attention).not.toContain("status-info");
  });

  it("treats `exited` as failed unless an exit code shows a deliberate stop", () => {
    expect(containerHealth(container("exited"))).toBe("failed");
    expect(containerHealth(container("exited", { exitCode: 1 }))).toBe("failed");
    expect(containerHealth(container("exited", { exitCode: 137 }))).toBe("failed");
    expect(containerHealth(container("exited", { exitCode: 0 }))).toBe("stopped");
    expect(containerHealth(container("exited", { exitCode: 143 }))).toBe("stopped");
  });

  it("keeps deliberate states grey, drawn as a ring rather than a faint fill", () => {
    for (const status of ["stopped", "created", "paused"] as const) {
      expect(containerHealth(container(status))).toBe("stopped");
    }
    expect(CONTAINER_HEALTH_DOT_CLASS.stopped).toContain("ring-muted-foreground");
    expect(CONTAINER_HEALTH_DOT_CLASS.stopped).not.toMatch(/bg-muted-foreground\/\d+/);
    expect(containerHealth(container("running"))).toBe("healthy");
  });

  it("aggregates a stack: partial needs attention, all-stopped fails only when a container failed", () => {
    expect(stackHealth(stack("running", [container("running")]))).toBe("healthy");
    expect(stackHealth(stack("partial", [container("running"), container("exited")]))).toBe("attention");
    expect(stackHealth(stack("stopped", [container("exited")]))).toBe("failed");
    expect(stackHealth(stack("stopped", [container("stopped"), container("created")]))).toBe("stopped");
  });
});

describe("container views share one mapping", () => {
  it("colours the card dot from the shared mapping (regression: exited was grey, restarting blue)", () => {
    const { rerender } = render(<ContainerCard container={container("exited")} />);
    let dot = screen.getByRole("img", { name: "Status: exited" });
    expect(dot).toHaveAttribute("data-health", "failed");
    expect(dot.className).toContain("bg-status-critical");

    rerender(<ContainerCard container={container("restarting")} />);
    dot = screen.getByRole("img", { name: "Status: restarting" });
    expect(dot).toHaveAttribute("data-health", "attention");
    expect(dot.className).toContain("bg-status-warning");

    rerender(<ContainerCard container={container("stopped")} />);
    dot = screen.getByRole("img", { name: "Status: stopped" });
    expect(dot.className).toContain("ring-muted-foreground");
  });

  it("has no per-view status colour tables left", () => {
    const SRC = join(__dirname, "..");
    for (const path of [
      "components/dashboard/container-card.tsx",
      "components/dashboard/container-detail-sheet.tsx",
      "components/dashboard/service-stack-list.tsx",
    ]) {
      const source = readFileSync(join(SRC, path), "utf8");
      expect(source, path).toContain('from "@/lib/container-status"');
      expect(source, path).not.toMatch(/exited:\s*"red"|status === "exited" \? "bg-status/);
    }
    const css = readFileSync(join(SRC, "app/globals.css"), "utf8");
    expect(css).not.toMatch(/\.status-dot\[data-status=/);
  });
});
