"use client";

import { useId } from "react";
import { DesktopAppToolbar } from "@/components/desktop/desktop-app-toolbar";
import {
  HugeiconsIcon,
  ArrowDown01Icon,
  MoreHorizontalIcon,
  PlayIcon,
  RemoteControlIcon,
} from "@/components/icons";
import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { WINDOW_SIDEBAR_REPLACES } from "@/components/ui/source-list";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { TerminalAgent } from "@/atoms/terminal";
import type { TerminalConnectionStatus } from "./terminal-inner";
import {
  TerminalAttachImageButton,
  TerminalConnectionState,
  TerminalKeyboardToggle,
  TerminalSessionPicker,
  useAttachImage,
  type TerminalSessionPickerProps,
} from "./terminal-session-toolbar";
import { TERMINAL_AGENTS, useTerminalHeaderAction } from "./use-terminal-header-action";

/** Menu rows a finger can hit (the menu primitives are sized for a pointer). */
const MENU_ROW = "pointer-coarse:min-h-11";

export interface TerminalToolbarProps extends TerminalSessionPickerProps {
  /** The terminal is connected: image uploads and agent launches can reach it. */
  connected: boolean;
  connectionStatus?: TerminalConnectionStatus | null;
  onReconnect?: () => void;
  /** Auto mode: launch agents without permission prompts (risk the person chose). */
  autoMode: boolean;
  onAutoModeChange: (next: boolean) => void;
  /** Remote control for the next Claude Code launch. */
  remote: boolean;
  onRemoteChange: (next: boolean) => void;
  /** A remote-control session was detected in the terminal's output. */
  remoteActive: boolean;
  onImageUpload?: (file: File) => void;
  showKeyboardToggle?: boolean;
  keyboardMode?: "virtual" | "physical";
  onToggleKeyboard?: () => void;
}

/**
 * The Terminal's toolbar. In a desktop window it renders into the window's
 * unified header row beside the session title;
 * in classic mode it is a full-width row above the terminal.
 *
 * Leading: the session picker (where no sidebar lists the sessions) and the
 * connection state. Trailing: the Auto switch, kept out of any menu because
 * it is risk the person chose, the image and keyboard controls, and one split
 * button that launches the agent, with the agent choice and remote control in
 * its menu. Where the row is narrow (a phone) the image and keyboard controls
 * share a "More" menu and the launch button drops its label, so every target
 * stays 44px on touch at 375px.
 */
export function TerminalToolbar({
  connected,
  connectionStatus,
  onReconnect,
  autoMode,
  onAutoModeChange,
  remote,
  onRemoteChange,
  remoteActive,
  onImageUpload,
  showKeyboardToggle,
  keyboardMode,
  onToggleKeyboard,
  ...picker
}: TerminalToolbarProps) {
  const agent = useTerminalHeaderAction();
  const attach = useAttachImage(onImageUpload);
  const keyboardToggle = showKeyboardToggle && onToggleKeyboard ? onToggleKeyboard : null;
  // Two small controls fold into one menu on a narrow row; one stays inline.
  const foldsOnNarrow = Boolean(keyboardToggle && onImageUpload);
  const inlineOnWide = foldsOnNarrow ? "hidden @md:inline-flex" : undefined;

  return (
    <DesktopAppToolbar
      data-terminal-toolbar=""
      data-compact-toolbar=""
      className="@container flex min-h-12 min-w-0 shrink-0 items-center gap-2 border-b border-border px-3 py-1.5"
    >
      <div className="flex min-w-0 flex-1 items-center gap-1.5">
        <TerminalSessionPicker {...picker} className={WINDOW_SIDEBAR_REPLACES} />
        <TerminalConnectionState status={connectionStatus} onReconnect={onReconnect} />
        {remoteActive && (
          <div role="status" title="Remote session active" className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
            <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-status-healthy" />
            <span className="truncate">
              Remote<span className="sr-only @md:not-sr-only"> session active</span>
            </span>
          </div>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-1">
        <AutoModeSwitch
          checked={autoMode}
          onCheckedChange={onAutoModeChange}
          agentLabel={agent.label}
          supported={agent.supports.auto}
        />
        {keyboardToggle && (
          <TerminalKeyboardToggle mode={keyboardMode} onToggle={keyboardToggle} className={inlineOnWide} />
        )}
        {attach.input}
        {onImageUpload && (
          <TerminalAttachImageButton onClick={attach.open} disabled={!connected} className={inlineOnWide} />
        )}
        {foldsOnNarrow && keyboardToggle && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                aria-label="More terminal controls"
                className="size-8 text-muted-foreground hover:text-foreground pointer-coarse:size-11 @md:hidden"
              >
                <HugeiconsIcon icon={MoreHorizontalIcon} size={16} aria-hidden="true" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-48">
              <DropdownMenuItem className={MENU_ROW} disabled={!connected} onSelect={attach.open}>
                Attach image…
              </DropdownMenuItem>
              <DropdownMenuCheckboxItem
                className={MENU_ROW}
                checked={keyboardMode === "virtual"}
                onCheckedChange={() => keyboardToggle()}
              >
                Virtual keyboard
              </DropdownMenuCheckboxItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        <AgentLaunchButton
          agent={agent.agent}
          label={agent.label}
          disabled={agent.disabled}
          supportsRemote={agent.supports.remote}
          remote={remote}
          onRemoteChange={onRemoteChange}
          onLaunch={agent.launch}
          onSelectAgent={agent.selectAgent}
        />
      </div>
    </DesktopAppToolbar>
  );
}

/**
 * Auto skips the agent's permission prompts. On, the switch fills amber (risk
 * the person chose) beside a foreground label; the label itself never takes a
 * status colour, so it reads on the window glass and on the page alike.
 */
function AutoModeSwitch({
  checked,
  onCheckedChange,
  agentLabel,
  supported,
}: {
  checked: boolean;
  onCheckedChange: (next: boolean) => void;
  agentLabel: string;
  supported: boolean;
}) {
  const hint = !supported
    ? `${agentLabel} keeps its own permission settings`
    : checked
      ? "Skip permission prompts"
      : "Require permission prompts";
  // The tooltip shows on hover only (its trigger is the label), so the switch
  // carries the same hint for screen readers and keyboard users.
  const hintId = useId();
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <label
          data-terminal-auto=""
          className="flex h-8 shrink-0 cursor-pointer select-none items-center gap-1.5 rounded-md px-2 text-sm font-medium transition-colors duration-150 hover:bg-accent dark:hover:bg-accent/50 pointer-coarse:h-11"
        >
          <Switch
            size="sm"
            checked={checked}
            aria-label="Auto: skip permission prompts"
            aria-describedby={hintId}
            className="data-[state=checked]:bg-status-warning"
            onCheckedChange={onCheckedChange}
          />
          <span className={checked ? "text-foreground" : "text-muted-foreground"}>Auto</span>
          <span id={hintId} className="sr-only">{hint}</span>
        </label>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="text-xs">{hint}</TooltipContent>
    </Tooltip>
  );
}

/**
 * One split button for the agent: the main part continues its last
 * conversation; the menu starts a new one, chooses the agent and turns remote
 * control on for the next launch. Both launches are agent launches, named for
 * the agent, so they never read as the shell's own sessions.
 */
function AgentLaunchButton({
  agent,
  label,
  disabled,
  supportsRemote,
  remote,
  onRemoteChange,
  onLaunch,
  onSelectAgent,
}: {
  agent: TerminalAgent;
  label: string;
  disabled: boolean;
  supportsRemote: boolean;
  remote: boolean;
  onRemoteChange: (next: boolean) => void;
  onLaunch: (resume: boolean) => void;
  onSelectAgent: (agent: TerminalAgent) => void;
}) {
  // Remote control lives in the menu; while it's on for the next launch the
  // button says so (an icon and its name), so the choice is never hidden.
  const withRemote = supportsRemote && remote;
  const continueName = withRemote ? `Continue ${label} with remote control` : `Continue ${label}`;
  return (
    // A hairline of the surface between the halves, not a drawn divider
    <ButtonGroup aria-label={label} className="gap-px">
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="secondary"
            size="sm"
            aria-label={continueName}
            disabled={disabled}
            className="h-8 min-w-8 gap-1.5 px-2.5 pointer-coarse:h-11 pointer-coarse:min-w-11"
            onClick={() => onLaunch(true)}
          >
            {/* Narrow rows show the play icon alone; mid-width rows the name alone; wide rows both */}
            <HugeiconsIcon icon={PlayIcon} size={14} aria-hidden="true" className="@sm:@max-md:hidden" />
            <span className="sr-only @sm:not-sr-only">{label}</span>
            {withRemote && (
              <HugeiconsIcon data-terminal-remote="" icon={RemoteControlIcon} size={14} aria-hidden="true" />
            )}
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="text-xs">
          Continue {label} where it left off{withRemote ? ", with remote control" : ""}
        </TooltipContent>
      </Tooltip>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="secondary"
            size="icon"
            aria-label={`More ${label} options`}
            className="size-8 pointer-coarse:size-11"
          >
            <HugeiconsIcon icon={ArrowDown01Icon} size={14} aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-60">
          <DropdownMenuItem className={MENU_ROW} disabled={disabled} onSelect={() => onLaunch(true)}>
            Continue {label}
          </DropdownMenuItem>
          <DropdownMenuItem className={MENU_ROW} disabled={disabled} onSelect={() => onLaunch(false)}>
            New {label} session
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">Agent</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={agent}
            onValueChange={(value) => {
              const next = TERMINAL_AGENTS.find((entry) => entry.id === value);
              if (next) onSelectAgent(next.id);
            }}
          >
            {TERMINAL_AGENTS.map((entry) => (
              <DropdownMenuRadioItem key={entry.id} value={entry.id} className={MENU_ROW}>
                {entry.label}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
          {supportsRemote && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuCheckboxItem
                className={MENU_ROW}
                checked={remote}
                // Stay open, so the change is seen
                onSelect={(event) => event.preventDefault()}
                onCheckedChange={(next) => onRemoteChange(next === true)}
              >
                Remote control for the next launch
              </DropdownMenuCheckboxItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </ButtonGroup>
  );
}

