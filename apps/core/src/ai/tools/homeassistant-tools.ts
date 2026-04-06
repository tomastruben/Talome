import { tool } from "ai";
import { z } from "zod";
import { getSetting } from "../../utils/settings.js";

interface HassConfig {
  baseUrl: string;
  token: string;
}

function getHassConfig(): HassConfig | null {
  const baseUrl = getSetting("homeassistant_url");
  const token = getSetting("homeassistant_token");
  if (!baseUrl || !token) return null;
  return { baseUrl: baseUrl.replace(/\/$/, ""), token };
}

async function hassFetch(path: string, options?: RequestInit): Promise<{ success: boolean; data?: unknown; error?: string; hint?: string }> {
  const config = getHassConfig();
  if (!config) {
    return {
      success: false,
      error: "Home Assistant is not configured. Add homeassistant_url and homeassistant_token in Settings.",
      hint: "Create a Long-Lived Access Token in Home Assistant under your Profile → Long-Lived Access Tokens.",
    };
  }
  try {
    const res = await fetch(`${config.baseUrl}/api${path}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${config.token}`,
        "Content-Type": "application/json",
        ...(options?.headers ?? {}),
      },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { success: false, error: `Home Assistant API error ${res.status}: ${text}` };
    }
    const ct = res.headers.get("content-type") ?? "";
    const data = ct.includes("application/json") ? await res.json() : await res.text();
    return { success: true, data };
  } catch (err: unknown) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ── hass_get_status ───────────────────────────────────────────────────────────

export const hassGetStatusTool = tool({
  description: "Check Home Assistant connection and get the current state/version.",
  inputSchema: z.object({}),
  execute: async () => {
    const result = await hassFetch("/");
    if (!result.success) return result;
    return { success: true, status: result.data };
  },
});

// ── hass_list_entities ────────────────────────────────────────────────────────

export const hassListEntitiesTool = tool({
  description: "List entities in Home Assistant. Filter by domain (e.g. 'light', 'switch', 'sensor', 'climate').",
  inputSchema: z.object({
    domain: z.string().optional().describe("Entity domain to filter by, e.g. 'light', 'switch', 'sensor'"),
    limit: z.number().default(50).describe("Maximum number of entities to return"),
  }),
  execute: async ({ domain, limit }) => {
    const result = await hassFetch("/states");
    if (!result.success) return result;
    let entities = result.data as Array<Record<string, unknown>>;
    if (domain) {
      entities = entities.filter((e) => (e.entity_id as string).startsWith(`${domain}.`));
    }
    const trimmed = entities.slice(0, limit).map((e) => ({
      entity_id: e.entity_id,
      state: e.state,
      friendly_name: (e.attributes as Record<string, unknown>)?.friendly_name,
    }));
    return { success: true, count: trimmed.length, entities: trimmed };
  },
});

// ── hass_call_service ─────────────────────────────────────────────────────────

export const hassCallServiceTool = tool({
  description: "Call a Home Assistant service to control devices. Examples: turn on/off lights, lock doors, set thermostat temperature.",
  inputSchema: z.object({
    domain: z.string().describe("Service domain, e.g. 'light', 'switch', 'climate', 'lock'"),
    service: z.string().describe("Service name, e.g. 'turn_on', 'turn_off', 'set_temperature'"),
    entityId: z.string().optional().describe("Target entity ID, e.g. 'light.living_room'"),
    serviceData: z.record(z.string(), z.unknown()).optional().describe("Additional service data, e.g. { brightness: 255, color_temp: 4000 }"),
  }),
  execute: async ({ domain, service, entityId, serviceData }) => {
    const body = {
      ...(entityId ? { entity_id: entityId } : {}),
      ...(serviceData ?? {}),
    };
    const result = await hassFetch(`/services/${domain}/${service}`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    if (!result.success) return result;
    return { success: true, message: `Called ${domain}.${service}${entityId ? ` on ${entityId}` : ""}.`, states: result.data };
  },
});

// ── hass_get_history ──────────────────────────────────────────────────────────

export const hassGetHistoryTool = tool({
  description: "Get the state history for a Home Assistant entity over the past N hours.",
  inputSchema: z.object({
    entityId: z.string().describe("Entity ID, e.g. 'sensor.temperature_living_room'"),
    hours: z.number().default(24).describe("Number of hours of history to retrieve"),
  }),
  execute: async ({ entityId, hours }) => {
    const start = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
    const result = await hassFetch(`/history/period/${start}?filter_entity_id=${entityId}&minimal_response`);
    if (!result.success) return result;
    const history = (result.data as Array<Array<Record<string, unknown>>>)[0] ?? [];
    return { success: true, entityId, hours, count: history.length, history };
  },
});

// ── hass_create_automation ────────────────────────────────────────────────────

export const hassCreateAutomationTool = tool({
  description: "Create a simple Home Assistant automation by providing trigger, condition, and action in natural language format. Returns the automation config YAML for review.",
  inputSchema: z.object({
    alias: z.string().describe("Name for the automation, e.g. 'Turn off lights at midnight'"),
    triggerEntityId: z.string().describe("Entity that triggers the automation, e.g. 'sun.sun'"),
    triggerPlatform: z.string().default("state").describe("Trigger platform: 'state', 'time', 'numeric_state', 'sun'"),
    triggerTo: z.string().optional().describe("State to trigger on, e.g. 'off' or 'below_horizon'"),
    actionDomain: z.string().describe("Service domain for the action, e.g. 'light'"),
    actionService: z.string().describe("Service to call, e.g. 'turn_off'"),
    actionEntityId: z.string().describe("Entity to act on, e.g. 'light.all_lights'"),
  }),
  execute: async ({ alias, triggerEntityId, triggerPlatform, triggerTo, actionDomain, actionService, actionEntityId }) => {
    const automation = {
      alias,
      trigger: [{ platform: triggerPlatform, entity_id: triggerEntityId, ...(triggerTo ? { to: triggerTo } : {}) }],
      condition: [],
      action: [{ service: `${actionDomain}.${actionService}`, target: { entity_id: actionEntityId } }],
      mode: "single",
    };

    const result = await hassFetch("/config/automation/config", {
      method: "POST",
      body: JSON.stringify(automation),
    });
    if (!result.success) {
      // Return the config for manual entry even if API call fails
      return {
        success: true,
        warning: "Could not create via API — paste this into your automations.yaml manually.",
        automation,
      };
    }
    return { success: true, message: `Automation '${alias}' created.`, automation };
  },
});
