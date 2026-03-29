import type {
  Client,
  Interaction,
  ChatInputCommandInteraction,
} from "discord.js";
import { routeMessage } from "./router.js";

let activeClient: Client | null = null;
let activeClientId: string | null = null;

export function getDiscordBotStatus(): { connected: boolean; username?: string } {
  if (activeClient?.isReady() && activeClient.user) {
    return { connected: true, username: activeClient.user.tag };
  }
  return { connected: false };
}

export async function stopDiscordBot(): Promise<void> {
  if (activeClient) {
    try {
      activeClient.destroy();
    } catch {
      // best-effort
    }
    activeClient = null;
    activeClientId = null;
    console.log("[discord] Bot stopped");
  }
}

export async function startDiscordBot(
  token: string
): Promise<{ ok: boolean; username?: string; error?: string }> {
  const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder } = await import("discord.js");

  await stopDiscordBot();

  try {
    const client = new Client({
      intents: [GatewayIntentBits.Guilds],
    });

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Login timed out")), 15_000);

      client.once("ready", () => {
        clearTimeout(timeout);
        resolve();
      });

      client.login(token).catch(reject);
    });

    if (!client.user) throw new Error("Client user not available after login");

    activeClientId = client.user.id;

    // Register the /talome slash command globally
    try {
      const talomeCommand = new SlashCommandBuilder()
        .setName("talome")
        .setDescription("Ask your Talome server AI")
        .addStringOption((opt) =>
          opt.setName("message").setDescription("What do you want to ask?").setRequired(true)
        );
      const rest = new REST({ version: "10" }).setToken(token);
      await rest.put(Routes.applicationCommands(activeClientId), {
        body: [talomeCommand.toJSON()],
      });
      console.log(`[discord] Registered /talome command for ${client.user.tag}`);
    } catch (err) {
      // Command registration failure is non-fatal — bot can still respond once commands propagate
      console.warn("[discord] Failed to register slash commands:", err);
    }

    client.on("interactionCreate", async (interaction: Interaction) => {
      if (!interaction.isChatInputCommand()) return;
      const cmd = interaction as ChatInputCommandInteraction;
      if (cmd.commandName !== "talome") return;

      const message = cmd.options.getString("message", true);
      const userId = cmd.user.id;
      const userName = cmd.user.displayName || cmd.user.username;

      // Defer reply — agent may take a few seconds
      await cmd.deferReply();

      try {
        const response = await routeMessage({
          platform: "discord",
          externalId: userId,
          text: message,
          senderName: userName,
        });

        // Discord has a 2000-char limit on messages
        const truncated =
          response.length > 1900 ? response.slice(0, 1900) + "\n…*(truncated)*" : response;
        await cmd.editReply(truncated);
      } catch (err) {
        console.error("[discord] interaction error:", err);
        await cmd.editReply("Sorry, something went wrong. Please try again.").catch(() => {});
      }
    });

    activeClient = client;
    return { ok: true, username: client.user.tag };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error("[discord] Failed to start bot:", error);
    return { ok: false, error };
  }
}
