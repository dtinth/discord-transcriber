import { joinVoiceChannel, VoiceConnectionStatus } from "@discordjs/voice";
import { Client, Events, GatewayIntentBits } from "discord.js";
import { loadAsrSetup, type AsrSetup } from "./asr-setup.ts";
import type { BudgetLimits } from "./budget.ts";
import config from "./config.ts";
import { TranscriptionService } from "./transcription.ts";
import { UsageStore } from "./usage-store.ts";

// Check for required environment variables
if (!config.DISCORD_TOKEN) {
  console.error("DISCORD_TOKEN environment variable is required");
  process.exit(1);
}

// Validate ASR configurations and credentials up front — failing here beats
// failing on the first utterance.
let asrSetup: AsrSetup;
try {
  asrSetup = loadAsrSetup(config.ASR_CONFIGURATIONS, process.env);
  console.log(
    `ASR configurations (retry order): ${asrSetup.configurations
      .map((c) => c.id)
      .join(", ")}`
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}

// Create a new Discord client
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent, // Privileged intent - must be enabled in Developer Portal
    GatewayIntentBits.GuildVoiceStates,
  ],
});

// Handle privileged intents error
client.on("error", (error) => {
  if (error.message.includes("disallowed intents")) {
    console.error("\n\n===== INTENT ERROR =====");
    console.error("This bot requires privileged intents to function properly.");
    console.error("Please enable these intents in the Discord Developer Portal:");
    console.error("1. Go to https://discord.com/developers/applications");
    console.error("2. Select your application");
    console.error("3. Go to the 'Bot' section");
    console.error("4. Under 'Privileged Gateway Intents', enable:");
    console.error("   - MESSAGE CONTENT INTENT");
    console.error("5. Save changes and restart the bot");
    console.error("========================\n\n");
    process.exit(1);
  } else {
    console.error("Discord client error:", error);
  }
});

// Initialize transcription service
// The ledger is opened before login: if the disk will not take the file, that
// must stop the bot now rather than after it has spent money it cannot record.
const usageStore = new UsageStore(config.USAGE_DB);
const budgetLimits: BudgetLimits = {
  totalUsd: config.BUDGET_USD,
  perGuildUsd: config.BUDGET_PER_GUILD_USD,
  period: config.BUDGET_PERIOD,
};
if (config.BUDGET_USD > 0) {
  console.log(
    `Budget: $${config.BUDGET_USD.toFixed(2)} per ${config.BUDGET_PERIOD}` +
      (config.BUDGET_PER_GUILD_USD > 0
        ? `, $${config.BUDGET_PER_GUILD_USD.toFixed(2)} per guild`
        : "") +
      ` (spent so far: $${usageStore.spentThisPeriod(config.BUDGET_PERIOD).toFixed(4)})`
  );
} else {
  console.log("Budget: no limit set (BUDGET_USD is 0)");
}

const transcriptionService = new TranscriptionService(
  asrSetup,
  usageStore,
  budgetLimits
);

// Map to track active transcription sessions
const activeTranscriptions = new Map();

client.once(Events.ClientReady, () => {
  console.log(`Logged in as ${client.user?.tag}`);
});

client.on(Events.MessageCreate, async (message) => {
  // Ignore messages from bots
  if (message.author.bot) return;

  // Check if message starts with prefix
  if (!message.content.startsWith(config.PREFIX)) return;

  const args = message.content.slice(config.PREFIX.length).trim().split(/ +/);
  const command = args.shift()?.toLowerCase();

  if (command === config.START_COMMAND) {
    // Check if user is in a voice channel
    const voiceChannel = message.member?.voice.channel;
    if (!voiceChannel) {
      message.reply("You need to be in a voice channel to use this command.");
      return;
    }

    // Check if bot already has an active transcription in this guild
    if (activeTranscriptions.has(message.guildId)) {
      message.reply("Transcription is already active in this server.");
      return;
    }

    try {
      // Join the voice channel
      const connection = joinVoiceChannel({
        channelId: voiceChannel.id,
        guildId: voiceChannel.guild.id,
        adapterCreator: voiceChannel.guild.voiceAdapterCreator,
      });

      // Set up transcription with text channel
      // Ensure we're working with a text channel
      if (!message.channel.isTextBased()) {
        message.reply("Command must be used in a text channel.");
        return;
      }

      const subscription = transcriptionService.createTranscriptionStream(
        connection,
        message.channel,
        { requesterId: message.author.id }
      );

      // Store the active transcription
      activeTranscriptions.set(message.guildId, {
        connection,
        subscription,
        textChannel: message.channel,
      });

      // Handle disconnection
      connection.on(VoiceConnectionStatus.Disconnected, () => {
        transcriptionService.stopTranscription(subscription);
        activeTranscriptions.delete(message.guildId);
      });

      message.reply(
        "Voice transcription started. I will transcribe all spoken text in this channel."
      );
    } catch (error) {
      console.error("Error joining voice channel:", error);
      message.reply("There was an error joining your voice channel.");
    }
  } else if (command === config.COST_COMMAND) {
    const summary = usageStore.summary(config.BUDGET_PERIOD, message.guildId ?? undefined);
    const overall = usageStore.spentThisPeriod(config.BUDGET_PERIOD);
    const cap =
      config.BUDGET_USD > 0
        ? ` of $${config.BUDGET_USD.toFixed(2)}`
        : " (no limit set)";
    message.reply(
      `This server this ${config.BUDGET_PERIOD}: **$${summary.totalUsd.toFixed(4)}** — ` +
        `${Math.round(summary.audioSeconds)}s of audio, ${summary.attempts} attempts` +
        (summary.failedAttempts > 0 ? ` (${summary.failedAttempts} failed)` : "") +
        `.\nAll servers: **$${overall.toFixed(4)}**${cap}.`
    );
  } else if (command === config.STOP_COMMAND) {
    // Check if there's an active transcription
    const transcription = activeTranscriptions.get(message.guildId);
    if (!transcription) {
      message.reply("There is no active transcription to stop.");
      return;
    }

    // Remove it from the active map first, so a second `!stop` cannot start a
    // second drain while this one is still waiting on the vendor.
    activeTranscriptions.delete(message.guildId);

    let attachment = null;
    try {
      attachment = await transcriptionService.finishAndBuildTranscript(
        transcription.subscription,
        () => {
          void message.channel
            .send("*Stopping — waiting for the last transcripts…*")
            .catch(() => {});
        }
      );
    } catch (error) {
      console.error("Error building the session transcript:", error);
    }

    // The connection is destroyed only after the transcript is built: tearing
    // it down first would abort the utterances still being transcribed, which
    // are exactly the ones the file would otherwise be missing.
    transcriptionService.stopTranscription(transcription.subscription);
    transcription.connection.destroy();

    if (attachment) {
      await message
        .reply({ content: "Voice transcription stopped.", files: [attachment] })
        .catch(async (error) => {
          console.error("Error uploading the transcript:", error);
          await message
            .reply("Voice transcription stopped, but the transcript could not be uploaded.")
            .catch(() => {});
        });
    } else {
      message.reply("Voice transcription stopped. Nothing was transcribed.");
    }
  }
});

// Log in to Discord with error handling
try {
  await client.login(config.DISCORD_TOKEN);
} catch (error: unknown) {
  if (error instanceof Error && error.message.includes("disallowed intents")) {
    console.error("\n\n===== INTENT ERROR =====");
    console.error("This bot requires privileged intents to function properly.");
    console.error("Please enable these intents in the Discord Developer Portal:");
    console.error("1. Go to https://discord.com/developers/applications");
    console.error("2. Select your application");
    console.error("3. Go to the 'Bot' section");
    console.error("4. Under 'Privileged Gateway Intents', enable:");
    console.error("   - MESSAGE CONTENT INTENT");
    console.error("5. Save changes and restart the bot");
    console.error("========================\n\n");
    process.exit(1);
  } else {
    console.error("Failed to log in to Discord:", error);
    process.exit(1);
  }
}
