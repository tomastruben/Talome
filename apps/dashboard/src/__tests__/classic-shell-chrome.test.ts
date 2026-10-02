import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(join(__dirname, "..", path), "utf8");

describe("classic shell chrome", () => {
  it("leaves the Terminal's controls to its own toolbar row (no second copy in the header)", () => {
    const header = read("components/layout/site-header.tsx");
    expect(header).not.toMatch(/TerminalHeaderAction|useTerminalHeaderAction|terminalAutoAtom|terminalRemoteAtom/);
    // The App Store's Create stays in the classic header, as Files' Upload does
    expect(header).toMatch(/isApps && \(/);
  });

  it("has no invalid unary minus before env() (the browser would drop the rule)", () => {
    expect(read("app/globals.css")).not.toMatch(/:\s*-env\(/);
  });
});
