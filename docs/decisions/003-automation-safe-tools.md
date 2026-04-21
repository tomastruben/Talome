# ADR-003: Automation-Safe Tool Subset

## Status
Accepted

## Context
Automations run unattended on schedules or triggers. Giving automations access to all tools is dangerous — destructive operations (uninstall app, prune resources, force config changes) should require human approval.

## Decision
A curated whitelist of tools is allowed in automations:
- **All read-tier tools** — automatically included (safe to query state)
- **Selected modify-tier tools** — explicitly listed in `AUTOMATION_SAFE_MODIFY_TOOLS` (restart, start, stop containers/apps, scan library, send notification, remember, set env, arr commands)
- **No destructive-tier tools** in automations

The `ai_prompt` step type in automations also uses this restricted tool set.

## Key files
- `apps/core/src/ai/automation-safe-tools.ts` — the whitelist
- `apps/core/src/automation/engine.ts` — enforcement during execution

## Consequences
- Automations can monitor and react (restart crashed services, send alerts) but can't destroy
- New tools must be explicitly added to the safe list — secure by default
- The `list_automation_safe_tools` tool lets users see what's available before creating automations
