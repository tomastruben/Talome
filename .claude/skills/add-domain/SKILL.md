# Add Domain — Register a new tool domain for an app integration

Use this skill when adding a new app integration (e.g. Plex, Immich, Nextcloud) to Talome's AI agent.

## What is a domain?

A domain is a group of tools that belong to a specific app. Tools are only loaded into the dashboard chat when the app is configured (has settings like `<app>_url`). The MCP server always loads all tools.

## Steps

### 1. Create the tool file

Create `apps/core/src/ai/tools/<app-name>-tools.ts`.

Follow the pattern from existing tool files (e.g. `jellyfin-tools.ts`, `pihole-tools.ts`):

```typescript
import { tool } from "ai";
import { z } from "zod";

export const myAppGetStatusTool = tool({
  description: "Get status of MyApp",
  parameters: z.object({}),
  execute: async () => {
    // Implementation using getSetting("myapp_url") and getSetting("myapp_api_key")
  },
});
```

Rules:
- Use Zod for all parameter schemas
- Read connection details from settings via `getSetting()`
- Return structured data, not raw API responses
- Handle missing configuration gracefully (return error message, don't throw)

### 2. Register the domain in agent.ts

Open `apps/core/src/ai/agent.ts` and:

1. **Import** your tools at the top with the other imports
2. **Add a `registerDomain()` call** following the existing pattern:

```typescript
registerDomain({
  name: "myapp",
  settingsKeys: ["myapp_url"],
  tools: {
    myapp_get_status: myAppGetStatusTool,
    // ... other tools
  },
  tiers: {
    myapp_get_status: "read",
    // read | modify | destructive
  },
});
```

### 3. Add automation-safe tools (if applicable)

If any tools should be available in automations, add them to `apps/core/src/ai/automation-safe-tools.ts`:
- Read-tier tools are auto-included
- Add modify-tier tools to `AUTOMATION_SAFE_MODIFY_TOOLS` only if they are safe for unattended execution

### 4. Typecheck

```bash
pnpm exec tsc --noEmit -p apps/core/tsconfig.json
```

### 5. Update CLAUDE.md

Add the new domain to the "Current domains" table in the Tool Architecture section.

## Key files

- `apps/core/src/ai/tool-registry.ts` — the registry engine (don't modify)
- `apps/core/src/ai/agent.ts` — domain registrations (add yours here)
- `apps/core/src/ai/automation-safe-tools.ts` — automation tool whitelist
- `apps/core/src/ai/tools/` — all tool definitions
