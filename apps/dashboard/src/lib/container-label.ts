import type { Container } from "@talome/types";

/** Docker can fall back to a hash when a stopped container has lost its name. */
export function containerDisplayName(container: Pick<Container, "name" | "image" | "labels">): string {
  if (container.name && !/^[a-f0-9]{12,64}$/i.test(container.name)) return container.name;
  return container.labels["com.docker.compose.service"]
    || container.image.split("/").pop()?.split(/[:@]/)[0]
    || "Service";
}

export function findContainerReference(containers: Container[], reference: string): Container | undefined {
  const normalized = reference.trim().toLowerCase();
  const exact = containers.find(container => container.name.toLowerCase() === normalized || container.id.toLowerCase() === normalized);
  if (exact) return exact;
  if (!/^[a-f0-9]{12,64}$/i.test(normalized)) return undefined;
  const matches = containers.filter(container => container.id.toLowerCase().startsWith(normalized));
  return matches.length === 1 ? matches[0] : undefined;
}
