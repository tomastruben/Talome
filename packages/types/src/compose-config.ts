/** Compose accepts both KEY=value lists and mappings, including inherited values. */
export function normalizeComposeEnvironment(value: unknown): Record<string, string | null> {
  if (Array.isArray(value)) {
    return Object.fromEntries(value.filter((entry): entry is string => typeof entry === "string").map((entry) => {
      const separator = entry.indexOf("=");
      return separator < 0 ? [entry, null] : [entry.slice(0, separator), entry.slice(separator + 1)];
    }));
  }
  if (!value || typeof value !== "object") return {};
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, entry == null ? null : String(entry)]));
}

export interface ComposePortDisplay {
  target: string;
  published: string;
  protocol: string;
  binding?: string;
  editable: boolean;
}

/** Preserve bind addresses, protocols and long syntax when changing a published port. */
export function describeComposePort(value: unknown): ComposePortDisplay | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const port = value as Record<string, unknown>;
    if (port.target == null) return null;
    const target = String(port.target);
    const published = port.published == null ? "" : String(port.published);
    return { target, published, protocol: String(port.protocol ?? "tcp"), binding: port.host_ip == null ? undefined : String(port.host_ip), editable: /^\d+$/.test(target) && (!published || /^\d+$/.test(published)) };
  }
  if (typeof value !== "string" && typeof value !== "number") return null;
  const [mapping, protocol = "tcp"] = String(value).split("/");
  const parts = mapping.split(":");
  const target = parts.pop()!;
  const published = parts.pop() ?? "";
  return { target, published, protocol, binding: parts.length ? parts.join(":") : undefined, editable: /^\d+$/.test(target) && (!published || /^\d+$/.test(published)) };
}

export function replaceComposePublishedPort(value: unknown, published: number): unknown {
  const port = describeComposePort(value);
  if (!port?.editable) throw new Error("Port ranges and unresolved variables must be edited in Compose directly");
  if (!Number.isInteger(published) || published < 1 || published > 65535) throw new Error("Host ports must be whole numbers from 1 to 65535");
  if (value && typeof value === "object") return { ...value, published: String(published) };
  const suffix = String(value).includes("/") ? `/${port.protocol}` : "";
  return `${port.binding ? `${port.binding}:` : ""}${published}:${port.target}${suffix}`;
}
