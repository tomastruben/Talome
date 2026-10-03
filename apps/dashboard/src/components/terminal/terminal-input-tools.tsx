"use client";

import { useEffect, useRef, useState } from "react";
import { VoiceBeam } from "voice-glow";
import { toast } from "sonner";
import { DictationGlyph } from "@/components/assistant/voice-dictation-button";
import { HugeiconsIcon, Edit02Icon, Mic01Icon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Textarea } from "@/components/ui/textarea";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useVoiceInput } from "@/hooks/use-voice-input";
import { unlockAudio } from "@/lib/audio-session";
import { terminalDraftText } from "./terminal-draft";

export function RenameTerminalSession({ name, onRename, disabled, className = "", labelled = false }: {
  name: string;
  onRename: (name: string) => Promise<void>;
  disabled?: boolean;
  className?: string;
  labelled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function save() {
    if (busy || !draft.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await onRename(draft);
      setOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't rename the session. Try again.");
    } finally { setBusy(false); }
  }
  return (
    <Dialog open={open} onOpenChange={(next) => {
      if (busy) return;
      if (next) { setDraft(name); setError(null); }
      setOpen(next);
    }}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="ghost" size={labelled ? "sm" : "icon-sm"} aria-label="Rename session" disabled={disabled} className={`shrink-0 text-muted-foreground pointer-coarse:min-h-11 ${className}`} onClick={() => { setDraft(name); setError(null); setOpen(true); }}>
            <HugeiconsIcon icon={Edit02Icon} size={16} strokeWidth={1.5} aria-hidden="true" />
            {labelled && <span>Rename session</span>}
          </Button>
        </TooltipTrigger>
        <TooltipContent>Rename session</TooltipContent>
      </Tooltip>
      <DialogContent className="rounded-2xl sm:max-w-md" onEscapeKeyDown={(e) => { if (busy) e.preventDefault(); }} onInteractOutside={(e) => { if (busy) e.preventDefault(); }}>
        <DialogHeader>
          <DialogTitle className="text-base font-medium">Rename session</DialogTitle>
          <DialogDescription>The shell and everything running in it keep their place.</DialogDescription>
        </DialogHeader>
        <form onSubmit={(e) => { e.preventDefault(); void save(); }} className="grid gap-6">
          <div className="grid gap-2">
            <Input aria-label="Session name" value={draft} maxLength={80} disabled={busy} onChange={(e) => setDraft(e.target.value)} autoFocus aria-invalid={!!error} />
            {error && <p role="alert" className="text-sm text-status-critical">{error}</p>}
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" disabled={busy} onClick={() => setOpen(false)}>Cancel</Button>
            <Button type="submit" disabled={!draft.trim()} busy={busy} busyLabel="Renaming session…">Save name</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function TerminalDictationDraft({ draft, setDraft, onInsert, connected }: {
  draft: string;
  setDraft: (text: string) => void;
  onInsert: (text: string) => void;
  connected: boolean;
}) {
  const prefix = useRef("");
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const voice = useVoiceInput({ onInterim: (text) => setDraft(prefix.current + text) });
  const active = voice.status === "starting" || voice.status === "listening";
  const processing = voice.status === "transcribing";
  const readLevel = () => voice.level.get();
  useEffect(() => { if (voice.error) toast.error(voice.error); }, [voice.error]);
  async function toggle() {
    unlockAudio();
    if (active) {
      const text = await voice.stop();
      if (mounted.current && text) setDraft(prefix.current + text);
    } else {
      prefix.current = draft ? `${draft.trimEnd()} ` : "";
      await voice.start();
    }
  }
  return (
    <div className="grid gap-3">
      <p className="text-sm font-medium">Terminal input</p>
      <VoiceBeam active={active} processing={processing} level={readLevel} borderRadius={24} theme="dark">
        <div className="rounded-3xl bg-muted/50 p-3">
          <Textarea aria-label="Terminal input draft" placeholder="Dictate or type a prompt…" value={draft} disabled={active || processing} onChange={(e) => setDraft(e.target.value)} className="min-h-24 resize-none border-0 bg-transparent shadow-none dark:bg-transparent" />
          <div className="flex items-center justify-between gap-2 pt-2">
            <Button variant="ghost" size="icon-sm" aria-label={processing ? "Transcribing dictation" : active ? "Stop dictation" : "Dictate"} aria-pressed={active} disabled={processing || !!voice.unavailableReason} title={voice.unavailableReason ?? "Dictate"} onClick={() => void toggle()}>
              {processing ? <Spinner className="size-4" /> : <DictationGlyph level={voice.level} active={active} />}
            </Button>
            <Button size="sm" disabled={!connected || active || processing || !terminalDraftText(draft).trim()} onClick={() => onInsert(terminalDraftText(draft))}>Insert text</Button>
          </div>
        </div>
      </VoiceBeam>
      <p className="text-sm text-muted-foreground">Review it here, then insert it. Press Enter in the terminal to submit.</p>
      {voice.unavailableReason && <p role="status" className="text-sm text-muted-foreground">{voice.unavailableReason}</p>}
    </div>
  );
}

export function TerminalDictation({ sessionId, connected, onInsert }: {
  sessionId: string;
  connected: boolean;
  onInsert: (text: string) => void;
}) {
  const [open, setOpen] = useState(false);
  // Keep each session's unfinished draft while the popover is closed or another
  // session is selected. Unmounting the recorder releases the microphone.
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label="Dictate terminal input" disabled={!connected} className="shrink-0 text-muted-foreground pointer-coarse:size-11">
              <HugeiconsIcon icon={Mic01Icon} size={16} strokeWidth={1.5} aria-hidden="true" />
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>Dictate terminal input</TooltipContent>
      </Tooltip>
      <PopoverContent align="end" className="dark w-[min(24rem,calc(100vw-2rem))] rounded-2xl p-4">
        {open && <TerminalDictationDraft key={sessionId} draft={drafts[sessionId] ?? ""} setDraft={(text) => setDrafts((prev) => ({ ...prev, [sessionId]: text }))} connected={connected} onInsert={(text) => {
          onInsert(text);
          setDrafts((prev) => ({ ...prev, [sessionId]: "" }));
          setOpen(false);
        }} />}
      </PopoverContent>
    </Popover>
  );
}
