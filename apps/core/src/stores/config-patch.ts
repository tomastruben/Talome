import { z } from "zod";
import { describeComposePort, normalizeComposeEnvironment, replaceComposePublishedPort } from "@talome/types";

const hostPort = z.number().int().min(1).max(65535);
export const configPatchSchema = z.object({
  serviceName: z.string().min(1).max(256),
  env: z.record(z.string().min(1), z.string()).optional(),
  // Legacy callers address container ports; the UI addresses exact mappings so
  // separate TCP/UDP or bind-address entries cannot overwrite each other.
  ports: z.record(z.string().regex(/^\d+(?:\/(?:tcp|udp|sctp))?$/), hostPort).optional(),
  portMappings: z.array(z.object({ index: z.number().int().nonnegative(), published: hostPort })).max(256).optional(),
}).refine((value) => value.env || value.ports || value.portMappings, "Provide environment or port changes");

export function patchComposeConfig(compose: unknown, patch: z.infer<typeof configPatchSchema>): Record<string, unknown> {
  if (!compose || typeof compose !== "object" || Array.isArray(compose)) throw new Error("Invalid Compose configuration");
  const result = structuredClone(compose) as Record<string, unknown>;
  const services = result.services as Record<string, Record<string, unknown>> | undefined;
  if (!services || !Object.hasOwn(services, patch.serviceName)) throw new Error(`Service '${patch.serviceName}' not found`);
  const service = services[patch.serviceName];
  if (!service || typeof service !== "object" || Array.isArray(service)) throw new Error("Invalid Compose service");
  if (patch.env) service.environment = { ...normalizeComposeEnvironment(service.environment), ...patch.env };
  if (patch.ports || patch.portMappings) {
    if (!Array.isArray(service.ports)) throw new Error("No port mappings found for this service");
    const ports = [...service.ports];
    for (const [target, published] of Object.entries(patch.ports ?? {})) {
      let matched = false;
      for (let index = 0; index < ports.length; index++) {
        const port = describeComposePort(ports[index]);
        if (port && (target === `${port.target}/${port.protocol}` || target === port.target)) {
          ports[index] = replaceComposePublishedPort(ports[index], published);
          matched = true;
        }
      }
      if (!matched) throw new Error(`Container port '${target}' not found`);
    }
    for (const entry of patch.portMappings ?? []) {
      if (entry.index >= ports.length) throw new Error("Port mapping not found; reload the configuration");
      ports[entry.index] = replaceComposePublishedPort(ports[entry.index], entry.published);
    }
    service.ports = ports;
  }
  return result;
}
