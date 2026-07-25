import type { TalomeValueFormat } from "@talome/types";

export function getValueAtPath(value: unknown, path: string): unknown {
  if (!path) return value;
  return path.split(".").reduce<unknown>((current, segment) => {
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current)) {
      const index = Number(segment);
      return Number.isInteger(index) ? current[index] : undefined;
    }
    if (typeof current !== "object") return undefined;
    return (current as Record<string, unknown>)[segment];
  }, value);
}

export function asRows(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
    : [];
}

function asDate(value: unknown): Date | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function formatNativeValue(
  value: unknown,
  format: TalomeValueFormat = "text",
  currency = "USD",
): string {
  if (value === null || value === undefined || value === "") return "—";

  switch (format) {
    case "number": {
      const number = Number(value);
      return Number.isFinite(number) ? new Intl.NumberFormat().format(number) : String(value);
    }
    case "currency": {
      const number = Number(value);
      return Number.isFinite(number)
        ? new Intl.NumberFormat(undefined, { style: "currency", currency }).format(number)
        : String(value);
    }
    case "percent": {
      const number = Number(value);
      if (!Number.isFinite(number)) return String(value);
      const normalized = Math.abs(number) <= 1 ? number : number / 100;
      return new Intl.NumberFormat(undefined, { style: "percent", maximumFractionDigits: 1 }).format(normalized);
    }
    case "bytes": {
      const number = Number(value);
      if (!Number.isFinite(number)) return String(value);
      if (number === 0) return "0 B";
      const unitIndex = Math.min(Math.floor(Math.log(Math.abs(number)) / Math.log(1024)), 4);
      const units = ["B", "KB", "MB", "GB", "TB"];
      return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(number / 1024 ** unitIndex)} ${units[unitIndex]}`;
    }
    case "date": {
      const date = asDate(value);
      return date ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(date) : String(value);
    }
    case "relative-time": {
      const date = asDate(value);
      if (!date) return String(value);
      const seconds = Math.round((date.getTime() - Date.now()) / 1000);
      const ranges: Array<[number, Intl.RelativeTimeFormatUnit]> = [
        [60, "second"],
        [60, "minute"],
        [24, "hour"],
        [7, "day"],
        [4.345, "week"],
        [12, "month"],
        [Number.POSITIVE_INFINITY, "year"],
      ];
      let valueInUnit = seconds;
      for (const [range, unit] of ranges) {
        if (Math.abs(valueInUnit) < range) {
          return new Intl.RelativeTimeFormat(undefined, { numeric: "auto" }).format(Math.round(valueInUnit), unit);
        }
        valueInUnit /= range;
      }
      return String(value);
    }
    default:
      return typeof value === "string" ? value : String(value);
  }
}
