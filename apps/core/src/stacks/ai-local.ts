import type { TalomeStack } from "@talome/types";

export const aiLocalStack: TalomeStack = {
  id: "ai-local",
  name: "Local AI",
  description:
    "Run AI models locally on your hardware. Ollama provides the inference engine, Open WebUI gives you a beautiful chat interface. No API keys, no cloud, no cost per query.",
  tagline: "Your AI. Your hardware. Zero cloud dependency.",
  author: "talome",
  tags: ["ai", "llm", "ollama", "local-ai"],
  version: "1.0.0",
  createdAt: "2026-03-01T00:00:00Z",
  apps: [
    {
      appId: "ollama",
      name: "Ollama",
      compose: `services:
  ollama:
    image: ollama/ollama:0.6.2
    container_name: ollama
    restart: unless-stopped
    ports:
      - "11434:11434"
    volumes:
      - ollama-data:/root/.ollama
volumes:
  ollama-data:
`,
      configSchema: { envVars: [] },
    },
    {
      appId: "open-webui",
      name: "Open WebUI",
      compose: `services:
  open-webui:
    image: ghcr.io/open-webui/open-webui:v0.6.8
    container_name: open-webui
    restart: unless-stopped
    ports:
      - "3005:8080"
    volumes:
      - open-webui-data:/app/backend/data
    environment:
      - OLLAMA_BASE_URL=http://ollama:11434
    depends_on:
      - ollama
volumes:
  open-webui-data:
`,
      configSchema: { envVars: [] },
    },
  ],
  postInstallPrompt:
    "The Local AI stack is installed. Pull a model first: run 'ollama pull llama3.2' or ask the Talome assistant to do it. Open WebUI is on port 3005 for a chat interface. You can also set Ollama as Talome's AI provider in Settings > AI Provider.",
};
