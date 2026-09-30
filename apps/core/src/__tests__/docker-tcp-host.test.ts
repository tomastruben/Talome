import { describe, it, expect } from "vitest";
import { parseTcpDockerHost } from "../docker/client.js";

describe("DOCKER_HOST tcp parsing", () => {
  it("parses host and port", () => {
    expect(parseTcpDockerHost("tcp://127.0.0.1:23750")).toEqual({ host: "127.0.0.1", port: 23750 });
  });
  it("defaults the port to 2375", () => {
    expect(parseTcpDockerHost("tcp://docker.lan")).toEqual({ host: "docker.lan", port: 2375 });
  });
  it("ignores unix sockets, empty and malformed values", () => {
    expect(parseTcpDockerHost("unix:///var/run/docker.sock")).toBeNull();
    expect(parseTcpDockerHost(undefined)).toBeNull();
    expect(parseTcpDockerHost("tcp://")).toBeNull();
  });
});
