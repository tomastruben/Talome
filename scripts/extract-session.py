#!/usr/bin/env python3
"""Extract context from Claude Code session JSONL files for resuming work.

Usage:
  # List recent sessions
  python3 scripts/extract-session.py --list

  # Summarized context (default) — human-readable markdown
  python3 scripts/extract-session.py [SESSION]

  # Raw filtered conversation — full messages, tool names (no bulky results)
  python3 scripts/extract-session.py --raw [SESSION]

  # Skip the current session when auto-selecting the most recent
  python3 scripts/extract-session.py --skip-current CURRENT_ID

SESSION can be:
  - A number (1 = most recent, 2 = second most recent)
  - A session ID prefix (at least 8 chars)
  - Omitted to select the most recent session
"""

import json
import sys
from pathlib import Path
from datetime import datetime

PROJECT_DIR = Path.home() / ".claude" / "projects" / "-Users-tomas-dev-Talome"
OUTPUT_DIR = PROJECT_DIR / "session-summaries"


def get_sessions():
    """Return session JSONL files sorted by modification time (newest first)."""
    return sorted(PROJECT_DIR.glob("*.jsonl"), key=lambda f: f.stat().st_mtime, reverse=True)


def list_sessions(limit=15):
    """Print recent sessions with metadata."""
    files = get_sessions()[:limit]
    for i, f in enumerate(files, 1):
        mtime = datetime.fromtimestamp(f.stat().st_mtime)
        size_kb = f.stat().st_size / 1024
        first_msg = ""
        try:
            with open(f) as fh:
                for line in fh:
                    obj = json.loads(line.strip())
                    if obj.get("type") == "user":
                        content = obj.get("message", {}).get("content", "")
                        if isinstance(content, str):
                            first_msg = content[:100].replace("\n", " ").strip()
                        elif isinstance(content, list):
                            for b in content:
                                if isinstance(b, dict) and b.get("type") == "text":
                                    first_msg = b["text"][:100].replace("\n", " ").strip()
                                    break
                        break
        except Exception:
            pass
        print(f"  {i:>2}. [{mtime:%Y-%m-%d %H:%M}] {size_kb:>7.0f}KB  {f.stem[:12]}…  {first_msg}")


def load_messages(filepath):
    """Load all JSONL entries from a session file."""
    messages = []
    with open(filepath) as f:
        for line in f:
            try:
                messages.append(json.loads(line.strip()))
            except json.JSONDecodeError:
                continue
    return messages


def extract_raw(filepath):
    """Extract filtered conversation as markdown — keeps full message text and
    tool call names/paths but strips bulky tool results and thinking blocks."""
    messages = load_messages(filepath)
    session_id = filepath.stem
    parts = []

    # Header
    start_time = end_time = git_branch = plan_slug = None
    for msg in messages:
        ts = msg.get("timestamp")
        if ts:
            if not start_time: start_time = ts
            end_time = ts
        if not git_branch: git_branch = msg.get("gitBranch")
        if not plan_slug and msg.get("slug"): plan_slug = msg["slug"]

    parts.append(f"# Session Transcript: {session_id[:12]}…")
    parts.append(f"**Date:** {start_time[:16] if start_time else '?'} → {end_time[11:16] if end_time else '?'}")
    parts.append(f"**Branch:** {git_branch or '?'}")
    if plan_slug:
        parts.append(f"**Plan:** {plan_slug}")
    parts.append("")

    for msg in messages:
        msg_type = msg.get("type")
        role = msg.get("message", {}).get("role")
        content = msg.get("message", {}).get("content", [])

        if msg_type == "user" and role == "user":
            # Extract actual text from user messages (skip tool_result wrappers)
            texts = []
            if isinstance(content, str) and content.strip():
                texts.append(content.strip())
            elif isinstance(content, list):
                for b in content:
                    if isinstance(b, dict) and b.get("type") == "text" and b.get("text", "").strip():
                        texts.append(b["text"].strip())
                    elif isinstance(b, dict) and b.get("type") == "image":
                        texts.append("[image attached]")
                    # Skip tool_result blocks — they're responses to tool_use, not user speech
            if texts:
                parts.append("---")
                parts.append("## USER")
                parts.extend(texts)
                parts.append("")

        elif msg_type == "assistant" and role == "assistant":
            if not isinstance(content, list):
                continue
            for b in content:
                if not isinstance(b, dict):
                    continue
                btype = b.get("type")

                if btype == "text" and b.get("text", "").strip():
                    parts.append("### ASSISTANT")
                    parts.append(b["text"].strip())
                    parts.append("")

                elif btype == "tool_use":
                    name = b.get("name", "")
                    inp = b.get("input", {})
                    # Show tool call with key params, not full content
                    params = _summarize_tool_input(name, inp)
                    parts.append(f"**→ {name}** {params}")

                # Skip thinking blocks entirely

        elif msg_type == "tool_result":
            # Include brief tool results for key tools (errors, status)
            content = msg.get("message", {}).get("content", "")
            if isinstance(content, str) and ("error" in content.lower() or "fail" in content.lower()):
                parts.append(f"**← error:** {content[:300]}")
                parts.append("")

    return "\n".join(parts)


def _summarize_tool_input(tool_name, inp):
    """Return a concise one-line summary of a tool call's parameters."""
    project_root = "/Users/tomas/dev/Talome/"

    def short_path(p):
        return p.replace(project_root, "") if isinstance(p, str) and p.startswith(project_root) else p

    if tool_name in ("Read", "Edit", "Write"):
        fp = short_path(inp.get("file_path", ""))
        if tool_name == "Edit":
            old = inp.get("old_string", "")[:60].replace("\n", "↵")
            new = inp.get("new_string", "")[:60].replace("\n", "↵")
            return f"`{fp}` — `{old}` → `{new}`"
        elif tool_name == "Write":
            return f"`{fp}` ({len(inp.get('content', ''))} chars)"
        else:
            offset = inp.get("offset", "")
            return f"`{fp}`" + (f" @{offset}" if offset else "")

    elif tool_name == "Bash":
        cmd = inp.get("command", "")[:150]
        return f"`{cmd}`"

    elif tool_name in ("Grep", "Glob"):
        pattern = inp.get("pattern", "")
        path = short_path(inp.get("path", ""))
        return f"`{pattern}`" + (f" in `{path}`" if path else "")

    elif tool_name == "Agent":
        desc = inp.get("description", "")
        return desc

    else:
        # MCP or other tools — show first few params
        summary_parts = []
        for k, v in list(inp.items())[:3]:
            sv = str(v)[:80]
            summary_parts.append(f"{k}={sv}")
        return " ".join(summary_parts) if summary_parts else ""


def extract_summary(filepath):
    """Extract a structured markdown summary from a session JSONL file."""
    messages = load_messages(filepath)
    session_id = filepath.stem

    start_time = end_time = git_branch = plan_slug = None
    user_messages = []
    assistant_texts = []
    files_edited = set()
    tool_counts = {}

    for msg in messages:
        ts = msg.get("timestamp")
        if ts:
            if not start_time: start_time = ts
            end_time = ts
        if not git_branch: git_branch = msg.get("gitBranch")
        if not plan_slug and msg.get("slug"): plan_slug = msg["slug"]

        msg_type = msg.get("type")
        role = msg.get("message", {}).get("role")
        content = msg.get("message", {}).get("content", [])

        if msg_type == "user" and role == "user":
            if isinstance(content, str):
                user_messages.append(content.strip())
            elif isinstance(content, list):
                for b in content:
                    if isinstance(b, dict) and b.get("type") == "text":
                        user_messages.append(b["text"].strip())

        if msg_type == "assistant" and role == "assistant" and isinstance(content, list):
            for b in content:
                if not isinstance(b, dict):
                    continue
                if b.get("type") == "text" and len(b.get("text", "").strip()) > 50:
                    assistant_texts.append(b["text"].strip())
                elif b.get("type") == "tool_use":
                    name = b.get("name", "")
                    tool_counts[name] = tool_counts.get(name, 0) + 1
                    fp = b.get("input", {}).get("file_path", "")
                    if name in ("Edit", "Write") and fp:
                        files_edited.add(fp)

    # Build summary
    parts = []
    parts.append(f"# Session Summary: {session_id[:12]}…")
    parts.append("")
    parts.append(f"**Date:** {start_time[:16] if start_time else '?'} → {end_time[11:16] if end_time else '?'}")
    parts.append(f"**Branch:** {git_branch or '?'}")
    if plan_slug:
        parts.append(f"**Plan:** {plan_slug}")
    parts.append("")

    parts.append("## User Requests")
    parts.append("")
    for i, msg in enumerate(user_messages, 1):
        display = msg[:500] + "…" if len(msg) > 500 else msg
        parts.append(f"{i}. {display}")
    parts.append("")

    parts.append("## Key Findings & Decisions")
    parts.append("")
    key_texts = [t for t in assistant_texts if len(t) > 200]
    for text in key_texts[-10:]:
        display = text[:1500] + "\n…(truncated)" if len(text) > 1500 else text
        parts.append(display)
        parts.append("")

    if files_edited:
        parts.append("## Files Modified")
        parts.append("")
        project_root = "/Users/tomas/dev/Talome/"
        for f in sorted(files_edited):
            short = f.replace(project_root, "") if f.startswith(project_root) else f
            parts.append(f"- `{short}`")
        parts.append("")

    if tool_counts:
        parts.append("## Tool Usage")
        parts.append("")
        for name, count in sorted(tool_counts.items(), key=lambda x: -x[1])[:10]:
            parts.append(f"- {name}: {count}")
        parts.append("")

    return "\n".join(parts)


def resolve_session(args):
    """Parse args and return the target session filepath."""
    sessions = get_sessions()
    if not sessions:
        print("No sessions found.", file=sys.stderr)
        sys.exit(1)

    # Extract --skip-current
    skip_id = None
    clean_args = list(args)
    if "--skip-current" in clean_args:
        idx = clean_args.index("--skip-current")
        if idx + 1 < len(clean_args):
            skip_id = clean_args[idx + 1]
        clean_args = [a for i, a in enumerate(clean_args) if i != idx and i != idx + 1]

    # Remove flags
    positional = [a for a in clean_args if not a.startswith("--")]
    target = positional[0] if positional else None

    if target and target.isdigit():
        idx = int(target) - 1
        filtered = [s for s in sessions if (not skip_id or skip_id not in s.stem)]
        if idx >= len(filtered):
            print(f"Only {len(filtered)} sessions available.", file=sys.stderr)
            sys.exit(1)
        return filtered[idx]

    elif target and len(target) >= 8:
        matches = [s for s in sessions if target in s.stem]
        if not matches:
            print(f"No session matching '{target}'.", file=sys.stderr)
            sys.exit(1)
        return matches[0]

    else:
        filtered = [s for s in sessions if (not skip_id or skip_id not in s.stem)]
        return filtered[0]


def main():
    args = sys.argv[1:]

    if "--list" in args:
        print("\nRecent sessions:")
        list_sessions()
        return

    filepath = resolve_session(args)

    if "--raw" in args:
        result = extract_raw(filepath)
    else:
        result = extract_summary(filepath)

    # Save and print
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    suffix = "-raw" if "--raw" in args else ""
    out_path = OUTPUT_DIR / f"{filepath.stem}{suffix}.md"
    with open(out_path, "w") as f:
        f.write(result)

    print(result)
    print(f"\n---\nSaved to: {out_path}", file=sys.stderr)


if __name__ == "__main__":
    main()
