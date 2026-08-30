import { joinVoiceChannel, VoiceConnectionStatus } from "@discordjs/voice";
import {
  Client,
  Events,
  GatewayIntentBits,
  GuildMember,
  MessageFlags,
  type ChatInputCommandInteraction,
} from "discord.js";
import { loadAsrSetup, type AsrSetup } from "./asr-setup.ts";
import type { BudgetLimits } from "./budget.ts";
import {
  buildUsageReply,
  START_SUBCOMMAND,
  STOP_SUBCOMMAND,
  transcriberCommand,
  USAGE_SUBCOMMAND,
} from "./commands.ts";
import config from "./config.ts";
import logger from "./logger.ts";
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

// No privileged intents. The bot is driven entirely by slash commands, which
// arrive as interactions and need no intent at all, so it never asks to read
// what anybody writes. `Guilds` keeps the guild and channel caches; the voice
// intent is how the bot sees which channel the caller is sitting in.
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

client.on("error", (error) => {
  console.error("Discord client error:", error);
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

client.once(Events.ClientReady, async (ready) => {
  console.log(`Logged in as ${ready.user.tag}`);
  try {
    await ready.application.commands.set([transcriberCommand.toJSON()]);
    console.log("Registered /transcriber (start, stop, usage)");
  } catch (error) {
    // Not fatal: a previous registration may still be live, and the bot is
    // useless but harmless without one. It must be loud, because the only
    // other symptom is a command that never appears when somebody types "/".
    console.error(
      "Could not register the slash commands. Check that the bot was invited " +
        "with the applications.commands scope:",
      error
    );
  }
});

/** `/transcriber start` — join the caller's voice channel and listen. */
async function handleStart(interaction: ChatInputCommandInteraction) {
  const member =
    interaction.member instanceof GuildMember
      ? interaction.member
      : await interaction.guild!.members.fetch(interaction.user.id);

  const voiceChannel = member.voice.channel;
  if (!voiceChannel) {
    await interaction.reply({
      content: "You need to be in a voice channel to use this command.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (activeTranscriptions.has(interaction.guildId)) {
    await interaction.reply({
      content: "Transcription is already active in this server.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (!interaction.channel?.isTextBased()) {
    await interaction.reply({
      content: "Command must be used in a text channel.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // Joining takes long enough to risk the 3 s acknowledgement deadline.
  await interaction.deferReply();

  try {
    const connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: voiceChannel.guild.id,
      adapterCreator: voiceChannel.guild.voiceAdapterCreator,
    });

    const subscription = transcriptionService.createTranscriptionStream(
      connection,
      interaction.channel,
      { requesterId: interaction.user.id }
    );

    activeTranscriptions.set(interaction.guildId, {
      connection,
      subscription,
      textChannel: interaction.channel,
    });

    connection.on(VoiceConnectionStatus.Disconnected, () => {
      transcriptionService.stopTranscription(subscription);
      activeTranscriptions.delete(interaction.guildId);
    });

    await interaction.editReply(
      "Voice transcription started. I will transcribe all spoken text in this channel."
    );
  } catch (error) {
    console.error("Error joining voice channel:", error);
    await interaction.editReply("There was an error joining your voice channel.");
  }
}

/** `/transcriber stop` — drain, upload the transcript, then leave. */
async function handleStop(interaction: ChatInputCommandInteraction) {
  const transcription = activeTranscriptions.get(interaction.guildId);
  if (!transcription) {
    await interaction.reply({
      content: "There is no active transcription to stop.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // Remove it from the active map first, so a second `/transcriber stop`
  // cannot start a second drain while this one is still waiting on the vendor.
  activeTranscriptions.delete(interaction.guildId);

  // Mandatory, not defensive: the drain below waits up to 20 s for the last
  // transcripts, and an interaction must be acknowledged within 3 s. Replying
  // straight away would lose the very file this command exists to produce.
  // Deferring buys 15 minutes, which the 20 s drain fits inside comfortably.
  await interaction.deferReply();

  let attachment = null;
  try {
    attachment = await transcriptionService.finishAndBuildTranscript(
      transcription.subscription,
      () => {
        void interaction
          .editReply("*Stopping — waiting for the last transcripts…*")
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
    await interaction
      .editReply({ content: "Voice transcription stopped.", files: [attachment] })
      .catch(async (error) => {
        console.error("Error uploading the transcript:", error);
        await interaction
          .editReply(
            "Voice transcription stopped, but the transcript could not be uploaded."
          )
          .catch(() => {});
      });
  } else {
    await interaction.editReply("Voice transcription stopped. Nothing was transcribed.");
  }
}

/** `/transcriber usage` — how much audio this server has transcribed. */
async function handleUsage(interaction: ChatInputCommandInteraction) {
  const summary = usageStore.summary(
    config.BUDGET_PERIOD,
    interaction.guildId ?? undefined
  );
  // Ephemeral: a question about this server's own usage is not news for the
  // channel, and the answer is the same however often it is asked.
  await interaction.reply({
    content: buildUsageReply(summary, config.BUDGET_PERIOD),
    flags: MessageFlags.Ephemeral,
  });
}

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== transcriberCommand.name) return;

  // Every subcommand needs a guild: two of them act on a voice channel and the
  // third reports that guild's usage.
  if (!interaction.inGuild()) {
    await interaction.reply({
      content: "This command only works in a server.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const subcommand = interaction.options.getSubcommand();
  try {
    if (subcommand === START_SUBCOMMAND) {
      await handleStart(interaction);
    } else if (subcommand === STOP_SUBCOMMAND) {
      await handleStop(interaction);
    } else if (subcommand === USAGE_SUBCOMMAND) {
      await handleUsage(interaction);
    }
  } catch (error) {
    // An unhandled throw here leaves the caller looking at a spinner until
    // Discord times it out, with nothing said about why.
    logger.error(`Error handling /transcriber ${subcommand}:`, error);
    const message = "Something went wrong while running that command.";
    await (interaction.deferred || interaction.replied
      ? interaction.editReply(message)
      : interaction.reply({ content: message, flags: MessageFlags.Ephemeral })
    ).catch(() => {});
  }
});

// Log in to Discord with error handling
try {
  await client.login(config.DISCORD_TOKEN);
} catch (error: unknown) {
  console.error("Failed to log in to Discord:", error);
  process.exit(1);
}
