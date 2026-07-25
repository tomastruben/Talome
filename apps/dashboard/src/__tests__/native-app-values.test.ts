import { describe, expect, it } from "vitest";
import { asRows, formatNativeValue, getValueAtPath } from "@/components/native-app/native-app-values";

describe("native app values", () => {
  it("resolves nested objects and array indexes without evaluating code", () => {
    const value = { accounts: [{ balance: 1250.5 }] };
    expect(getValueAtPath(value, "accounts.0.balance")).toBe(1250.5);
    expect(getValueAtPath(value, "accounts.1.balance")).toBeUndefined();
  });

  it("formats domain values consistently", () => {
    expect(formatNativeValue(0.421, "percent")).toBe("42.1%");
    expect(formatNativeValue(1_073_741_824, "bytes")).toBe("1 GB");
    expect(formatNativeValue(null)).toBe("—");
  });

  it("accepts only object rows", () => {
    expect(asRows([{ id: 1 }, null, "bad", { id: 2 }])).toEqual([{ id: 1 }, { id: 2 }]);
  });
});
