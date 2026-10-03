import type { ReactNode } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { motionValue } from "motion/react";

const voice = vi.hoisted(() => ({ status: "idle", stop: vi.fn(), start: vi.fn(), interim: null as null | ((text: string) => void) }));
vi.mock("voice-glow", () => ({ VoiceBeam: ({ children }: { children: ReactNode }) => children }));
vi.mock("@/hooks/use-voice-input", () => ({ useVoiceInput: (options: { onInterim: (text: string) => void }) => {
  voice.interim = options.onInterim;
  return { status: voice.status, level: motionValue(0), start: voice.start, stop: voice.stop, cancel: vi.fn(), error: null, unavailableReason: null };
} }));
vi.mock("@/lib/audio-session", () => ({ unlockAudio: vi.fn() }));
import { RenameTerminalSession, TerminalDictation } from "@/components/terminal/terminal-input-tools";
import { terminalDraftText } from "@/components/terminal/terminal-draft";
import { TooltipProvider } from "@/components/ui/tooltip";

beforeEach(() => { vi.clearAllMocks(); voice.status = "idle"; });

it("keeps a failed rename editable, then closes on success", async () => {
  const rename = vi.fn().mockRejectedValueOnce(new Error("Service unavailable")).mockResolvedValueOnce(undefined);
  render(<TooltipProvider><RenameTerminalSession name="session 1" onRename={rename} /></TooltipProvider>);
  fireEvent.click(screen.getByRole("button", { name: "Rename session" }));
  fireEvent.change(screen.getByLabelText("Session name"), { target: { value: "My build" } });
  fireEvent.click(screen.getByRole("button", { name: "Save name" }));
  await screen.findByRole("alert");
  expect(screen.getByLabelText("Session name")).toHaveValue("My build");
  fireEvent.click(screen.getByRole("button", { name: "Save name" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  expect(rename).toHaveBeenLastCalledWith("My build");
});

it("keeps speech in a reviewable draft and only inserts on an explicit click", async () => {
  const insert = vi.fn();
  render(<TooltipProvider><TerminalDictation sessionId="sess_test" connected onInsert={insert} /></TooltipProvider>);
  fireEvent.click(screen.getByRole("button", { name: "Dictate terminal input" }));
  fireEvent.click(screen.getByRole("button", { name: "Dictate", exact: true }));
  expect(voice.start).toHaveBeenCalled();
  voice.interim!("Show the logs");
  await waitFor(() => expect(screen.getByLabelText("Terminal input draft")).toHaveValue("Show the logs"));
  expect(insert).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText("Terminal input draft"), { target: { value: "Show the logs\n\u001b[31m" } });
  fireEvent.click(screen.getByRole("button", { name: "Insert text" }));
  expect(insert).toHaveBeenCalledExactlyOnceWith("Show the logs [31m");
});

it("preserves unfinished drafts separately when switching sessions", async () => {
  const props = { connected: true, onInsert: vi.fn() };
  const { rerender } = render(<TooltipProvider><TerminalDictation sessionId="sess_one" {...props} /></TooltipProvider>);
  fireEvent.click(screen.getByRole("button", { name: "Dictate terminal input" }));
  fireEvent.change(screen.getByLabelText("Terminal input draft"), { target: { value: "Unfinished prompt" } });
  rerender(<TooltipProvider><TerminalDictation sessionId="sess_two" {...props} /></TooltipProvider>);
  expect(screen.getByLabelText("Terminal input draft")).toHaveValue("");
  rerender(<TooltipProvider><TerminalDictation sessionId="sess_one" {...props} /></TooltipProvider>);
  expect(screen.getByLabelText("Terminal input draft")).toHaveValue("Unfinished prompt");
  expect(props.onInsert).not.toHaveBeenCalled();
});

it("removes terminal control bytes and submission characters from inserted drafts", () => {
  expect(terminalDraftText("hello\r\nworld\t\x03\x15\x1b[200~")).toBe("hello world [200~");
});
