import { describe, expect, it } from "vitest";
import { formatUptime, greetingFor } from "@/components/widgets/clock-widget";

describe("clock widget", () => {
  it("shows uptime at a glance", () => {
    expect(formatUptime(30)).toBe("1m");
    expect(formatUptime(12 * 60)).toBe("12m");
    expect(formatUptime(5 * 3600 + 12 * 60)).toBe("5h 12m");
    expect(formatUptime(3 * 86400 + 4 * 3600 + 59 * 60)).toBe("3d 4h");
  });

  it("greets by time of day", () => {
    expect(greetingFor(3)).toBe("Good night");
    expect(greetingFor(9)).toBe("Good morning");
    expect(greetingFor(14)).toBe("Good afternoon");
    expect(greetingFor(20)).toBe("Good evening");
  });
});
