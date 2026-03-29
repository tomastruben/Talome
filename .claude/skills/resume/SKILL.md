# Resume — Load context from a previous session

Use this skill when starting a new conversation and needing context from a previous session that was lost, crashed, or ran out of context.

## How it works

Claude Code saves every conversation as a JSONL file in `~/.claude/projects/-Users-tomas-dev-Talome/`. The `scripts/extract-session.py` script can extract context in two formats:

- **Summary mode** (default): structured markdown with user requests, key findings, files modified, tool stats. Good for quick orientation.
- **Raw mode** (`--raw`): full conversation transcript with all user messages, assistant responses, and tool call names/paths — but without bulky tool results and thinking blocks. Good for Claude to deeply understand what happened.

## Commands

```bash
# List recent sessions
python3 scripts/extract-session.py --list

# Summary of most recent previous session
python3 scripts/extract-session.py --skip-current "$CLAUDE_SESSION_ID"

# Raw transcript of most recent previous session
python3 scripts/extract-session.py --raw --skip-current "$CLAUDE_SESSION_ID"

# Specific session by index (1 = most recent)
python3 scripts/extract-session.py --raw 4

# Specific session by ID prefix
python3 scripts/extract-session.py --raw ab2fb357
```

## Workflow

1. **List sessions** if the user hasn't specified which one: `--list`
2. **Extract with `--raw`** by default — gives the most complete context for picking up where things left off
3. **Read the output** — understand what was done, what was in progress, what decisions were made
4. **Check current file state** — the transcript shows what was planned/attempted, but `git diff` and reading files shows what actually landed
5. **Cross-reference plans** — if the session references a plan slug, read it from `~/.claude/plans/{slug}.md`
6. **Present status to user** — concise: what's done, what's in progress, what's next
7. **Continue work** — pick up where the previous session left off

## When to use summary vs raw

- **`/resume`** (no args) → raw mode, most recent previous session. Best for "continue where I left off"
- **`/resume --list`** → show recent sessions so user can pick
- **`/resume N`** or **`/resume SESSION_ID`** → raw mode on specific session
- Use summary mode only when the raw output is too large (>100KB sessions)

## Key directories

- Session JSONL files: `~/.claude/projects/-Users-tomas-dev-Talome/*.jsonl`
- Cached summaries: `~/.claude/projects/-Users-tomas-dev-Talome/session-summaries/`
- Plans: `~/.claude/plans/`
- Architecture docs: `docs/architecture-audit.md`, `docs/decisions/`
