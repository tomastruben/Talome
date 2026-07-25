import type { Container } from "@talome/types";

const COMMON_WEB_CONTAINER_PORTS = new Set([
  80,
  443,
  3000,
  3001,
  4000,
  5000,
  8000,
  8001,
  8080,
  8081,
  8090,
  8096,
  8123,
  8181,
  8191,
  8345,
  8443,
  8787,
  8920,
  8989,
  9000,
  9117,
  9443,
  9696,
  13378,
  54323,
]);

const NON_WEB_CONTAINER_PORTS = new Set([
  53,
  1900,
  5353,
  5432,
  6379,
  6881,
  7359,
]);

/** Prefer a container's conventional web UI port over protocol/discovery ports. */
export function getContainerWebPort(container: Container): number | undefined {
  const tcpPorts = container.ports.filter((port) => port.protocol === "tcp" && port.host > 0);
  return tcpPorts.find((port) => COMMON_WEB_CONTAINER_PORTS.has(port.container))?.host
    ?? tcpPorts.find((port) => !NON_WEB_CONTAINER_PORTS.has(port.container))?.host
    ?? tcpPorts[0]?.host;
}
