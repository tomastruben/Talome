import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

vi.mock("../utils/settings.js", () => ({
  getSetting: vi.fn(() => null),
}));

import { vaultwardenInviteUserTool } from "../ai/tools/vaultwarden-tools.js";

describe("Assistant tool JSON Schema compatibility", () => {
  it("does not emit the unsupported email lookaround regex", () => {
    const schema = z.toJSONSchema(vaultwardenInviteUserTool.inputSchema as z.ZodType);
    const serialized = JSON.stringify(schema);

    expect(serialized).not.toContain('"pattern"');
    expect(serialized).not.toContain("(?");
  });
});
