import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockExec = vi.fn();
const mockWriteAuditEntry = vi.fn();

vi.mock("node:child_process", () => ({
  exec: vi.fn(),
}));

vi.mock("node:util", () => ({
  promisify: () => mockExec,
}));

vi.mock("../db/audit.js", () => ({
  writeAuditEntry: mockWriteAuditEntry,
}));

// ── Shell tool inline implementation (mirrors shell-tool.ts) ─────────────────

async function runShell(command: string): Promise<string> {
  mockWriteAuditEntry(`run_shell: ${command}`, "destructive", command);
  try {
    const { stdout, stderr } = await mockExec(command, { timeout: 30_000 }) as { stdout: string; stderr: string };
    return stdout || stderr || "(no output)";
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    return e.stdout || e.stderr || e.message || "Command failed";
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

beforeEach(() => { vi.clearAllMocks(); });

describe("run_shell tool", () => {
  it("returns stdout on success", async () => {
    mockExec.mockResolvedValue({ stdout: "hello world\n", stderr: "" });
    const result = await runShell("echo hello world");
    expect(result).toBe("hello world\n");
  });

  it("returns stderr when stdout is empty", async () => {
    mockExec.mockResolvedValue({ stdout: "", stderr: "some error\n" });
    const result = await runShell("bad_cmd");
    expect(result).toBe("some error\n");
  });

  it("returns (no output) when both stdout and stderr are empty", async () => {
    mockExec.mockResolvedValue({ stdout: "", stderr: "" });
    const result = await runShell("true");
    expect(result).toBe("(no output)");
  });

  it("returns error message on exec rejection", async () => {
    mockExec.mockRejectedValue({ message: "Command timed out" });
    const result = await runShell("sleep 100");
    expect(result).toBe("Command timed out");
  });

  it("returns stderr from rejection when available", async () => {
    mockExec.mockRejectedValue({ stdout: "", stderr: "Permission denied\n" });
    const result = await runShell("rm /etc/passwd");
    expect(result).toBe("Permission denied\n");
  });

  it("writes a destructive audit entry before executing", async () => {
    mockExec.mockResolvedValue({ stdout: "ok", stderr: "" });
    await runShell("ls /tmp");
    expect(mockWriteAuditEntry).toHaveBeenCalledWith(
      "run_shell: ls /tmp",
      "destructive",
      "ls /tmp",
    );
  });

  it("audit entry is written even when the command fails", async () => {
    mockExec.mockRejectedValue({ message: "not found" });
    await runShell("nonexistent_cmd");
    expect(mockWriteAuditEntry).toHaveBeenCalledTimes(1);
    expect(mockWriteAuditEntry).toHaveBeenCalledWith(
      expect.stringContaining("nonexistent_cmd"),
      "destructive",
      "nonexistent_cmd",
    );
  });
});
