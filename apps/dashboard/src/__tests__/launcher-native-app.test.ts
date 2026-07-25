import { describe, expect, it } from "vitest";
import type { Container, ServiceStack } from "@talome/types";
import { extractLaunchableApps } from "@/components/widgets/launcher-widget";
import { getContainerWebPort } from "@/lib/container-web-port";

function container(input: Partial<Container> & Pick<Container, "id" | "name">): Container {
  return {
    id: input.id,
    name: input.name,
    image: input.image ?? "weather-guard:test",
    status: input.status ?? "running",
    state: input.state ?? "running",
    ports: input.ports ?? [],
    mounts: input.mounts ?? [],
    labels: input.labels ?? {},
    created: input.created ?? 1,
    ...input,
  };
}

describe("native app launcher entries", () => {
  it("represents a native multi-container stack as one named Talome app", () => {
    const ui = container({
      id: "ui-id",
      name: "weather-guard-ui",
      ports: [{ host: 5002, container: 3000, protocol: "tcp" }],
    });
    const api = container({
      id: "api-id",
      name: "weather-api",
      ports: [{ host: 5001, container: 5000, protocol: "tcp" }],
    });
    const stack = {
      id: "weather-guard",
      name: "Server Weather Guard",
      source: "talome",
      status: "running",
      primaryContainer: ui,
      containers: [ui, api],
      runningCount: 2,
      totalCount: 2,
      storeId: "user-apps",
      appId: "weather-guard",
      icon: "⛈️",
      nativeSurface: { schemaVersion: 1, revision: 1, status: "approved" },
    } satisfies ServiceStack;

    const apps = extractLaunchableApps([stack]);

    expect(apps).toHaveLength(1);
    expect(apps[0]).toMatchObject({
      id: "weather-guard-ui",
      name: "Server Weather Guard",
      icon: "⛈️",
    });
    expect(apps[0].url).toContain("/dashboard/native-apps/user-apps/weather-guard");
    expect(getContainerWebPort(stack.primaryContainer)).toBe(5002);
  });
});
