import type { TalomeStack } from "@talome/types";

export const smartHomeStack: TalomeStack = {
  id: "smart-home",
  name: "Smart Home",
  description:
    "A complete smart home automation stack: Home Assistant as the hub, Mosquitto for MQTT messaging, Node-RED for visual automations, and Zigbee2MQTT for Zigbee device integration.",
  tagline: "Automate your home. Own your data.",
  author: "talome",
  tags: ["smart-home", "home-assistant", "iot", "automation"],
  version: "1.0.0",
  createdAt: "2026-03-01T00:00:00Z",
  apps: [
    {
      appId: "homeassistant",
      name: "Home Assistant",
      compose: `services:
  homeassistant:
    image: ghcr.io/home-assistant/home-assistant:stable
    container_name: homeassistant
    restart: unless-stopped
    network_mode: host
    volumes:
      - homeassistant-config:/config
    environment:
      - TZ=Europe/London
volumes:
  homeassistant-config:
`,
      configSchema: {
        envVars: [
          { key: "TZ", description: "Timezone", required: false, defaultValue: "Europe/London" },
        ],
      },
    },
    {
      appId: "mosquitto",
      name: "Mosquitto MQTT",
      compose: `services:
  mosquitto:
    image: eclipse-mosquitto:2.0.21
    container_name: mosquitto
    restart: unless-stopped
    ports:
      - "1883:1883"
      - "9001:9001"
    volumes:
      - mosquitto-config:/mosquitto/config
      - mosquitto-data:/mosquitto/data
      - mosquitto-log:/mosquitto/log
volumes:
  mosquitto-config:
  mosquitto-data:
  mosquitto-log:
`,
      configSchema: { envVars: [] },
    },
    {
      appId: "node-red",
      name: "Node-RED",
      compose: `services:
  node-red:
    image: nodered/node-red:4.0.9
    container_name: node-red
    restart: unless-stopped
    ports:
      - "1880:1880"
    volumes:
      - node-red-data:/data
    environment:
      - TZ=Europe/London
volumes:
  node-red-data:
`,
      configSchema: {
        envVars: [
          { key: "TZ", description: "Timezone", required: false, defaultValue: "Europe/London" },
        ],
      },
    },
  ],
  postInstallPrompt: `The Smart Home stack has been installed. Home Assistant is running on port 8123 (host network mode), Mosquitto MQTT on port 1883, and Node-RED on port 1880. The user should configure Home Assistant to connect to Mosquitto via the MQTT integration at http://localhost:8123.`,
};
