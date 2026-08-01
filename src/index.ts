import { joinVoiceChannel, VoiceConnectionStatus } from "@discordjs/voice";
import { Client, Events, GatewayIntentBits } from "discord.js";
import { loadAsrSetup, type AsrSetup } from "./asr-setup.ts";
import config from "./config.ts";
import { TranscriptionService } from "./transcription.ts";

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
const transcriptionService = new TranscriptionService(asrSetup);

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
        message.channel
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
  } else if (command === config.STOP_COMMAND) {
    // Check if there's an active transcription
    const transcription = activeTranscriptions.get(message.guildId);
    if (!transcription) {
      message.reply("There is no active transcription to stop.");
      return;
    }

    // Stop transcription
    transcriptionService.stopTranscription(transcription.subscription);
    transcription.connection.destroy();
    activeTranscriptions.delete(message.guildId);

    message.reply("Voice transcription stopped.");
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
