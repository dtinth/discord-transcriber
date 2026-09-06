import {
  getVoiceConnection,
  joinVoiceChannel,
  VoiceConnectionStatus,
} from "@discordjs/voice";
import {
  Client,
  Events,
  GatewayIntentBits,
  GuildMember,
  MessageFlags,
  type ChatInputCommandInteraction,
  type TextBasedChannel,
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
import { GuildSessions } from "./guild-sessions.ts";
import { startStatsServer, type BotStats } from "./http-server.ts";
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

// Live transcription sessions, one per guild. Every removal is checked
// against the subscription that owns the entry — see GuildSessions.
/**
 * How to detach each session's `Disconnected` listener.
 *
 * The guild's voice connection outlives a session and is handed back by
 * `joinVoiceChannel`, so a listener left attached fires for sessions that
 * replaced it.
 */
const disconnectListeners = new Map<string, () => void>();

const activeTranscriptions = new GuildSessions<
  { destroy: () => void },
  TextBasedChannel
>();

const PROCESS_STARTED_AT = Date.now();

/** The snapshot served by GET /stats. Read fresh on every request. */
function collectStats(): BotStats {
  const now = Date.now();
  const sessions = activeTranscriptions.entries().map(
    ([guildId, entry]) => {
      const stats = transcriptionService.sessionStats(entry.subscription);
      return {
        guildId,
        channelId: entry.channelId ?? null,
        startedAt: new Date(entry.startedAt).toISOString(),
        uptimeSeconds: Math.round((now - entry.startedAt) / 1000),
        ...stats,
      };
    }
  );
  return {
    startedAt: new Date(PROCESS_STARTED_AT).toISOString(),
    uptimeSeconds: Math.round((now - PROCESS_STARTED_AT) / 1000),
    activeSessions: sessions.length,
    busy: sessions.some(
      (session) => session.speakers > 0 || session.pendingUtterances > 0
    ),
    sessions,
  };
}

if (config.IDLE_TIMEOUT_MS > 0) {
  // Checked once a minute; the timeout is half an hour, so the granularity
  // costs nothing and the sweep stays off the hot path entirely.
  setInterval(() => {
    void sweepIdleSessions().catch((error) =>
      console.error("Error sweeping idle sessions:", error)
    );
  }, 60_000);
  console.log(
    `Idle sessions are closed after ${Math.round(config.IDLE_TIMEOUT_MS / 60000)} minutes with no voice`
  );
} else {
  console.log("Idle disconnect disabled (IDLE_TIMEOUT_MS is 0)");
}

if (config.HTTP_PORT > 0) {
  startStatsServer(config.HTTP_PORT, config.HTTP_HOST, collectStats);
} else {
  console.log("Stats server disabled (HTTP_PORT is 0)");
}

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
  // Guaranteed by the `inGuild()` check in the dispatcher; narrowing it there
  // does not survive the call, so it is restated rather than asserted away.
  const guildId = interaction.guildId;
  if (!guildId) return;


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

  const existing = activeTranscriptions.get(guildId);
  if (existing) {
    // A draining session still owns the guild's voice connection. Starting a
    // second one here would share that connection, and the finishing stop
    // would then destroy it underneath the new session.
    await interaction.reply({
      content: existing.closing
        ? "This server's transcription is still stopping — try again in a moment."
        : "Transcription is already active in this server.",
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

    activeTranscriptions.set(guildId, {
      connection,
      subscription,
      textChannel: interaction.channel,
      channelId: voiceChannel.id,
      startedAt: Date.now(),
    });

    // Identity-checked, and removed again when the session ends. The guild's
    // voice connection is shared and reused by `joinVoiceChannel`, so without
    // both of these an old session's listener stays attached and evicts a
    // *newer* session's entry, orphaning a session nothing can reach.
    const onDisconnected = () => {
      transcriptionService.stopTranscription(subscription);
      activeTranscriptions.deleteIf(guildId, subscription);
      connection.off(VoiceConnectionStatus.Disconnected, onDisconnected);
    };
    connection.on(VoiceConnectionStatus.Disconnected, onDisconnected);
    disconnectListeners.set(subscription, () =>
      connection.off(VoiceConnectionStatus.Disconnected, onDisconnected)
    );

    await interaction.editReply(
      "Voice transcription started. I will transcribe all spoken text in this channel."
    );
  } catch (error) {
    console.error("Error joining voice channel:", error);
    await interaction.editReply("There was an error joining your voice channel.");
  }
}

/**
 * Close a session and build its transcript.
 *
 * Shared by `/transcriber stop` and the idle sweep, because the order here is
 * the part that is easy to get wrong: the voice connection must be destroyed
 * only *after* the transcript is built, or tearing it down aborts the very
 * utterances the file would otherwise be missing.
 *
 * The caller removes the session from `activeTranscriptions` first, so a
 * second stop cannot start a second drain while this one is still waiting.
 */
async function closeSession(
  entry: { subscription: string; connection: { destroy: () => void } },
  onWaiting?: () => void
) {
  let attachment = null;
  try {
    attachment = await transcriptionService.finishAndBuildTranscript(
      entry.subscription,
      onWaiting
    );
  } catch (error) {
    console.error("Error building the session transcript:", error);
  }

  transcriptionService.stopTranscription(entry.subscription);
  disconnectListeners.get(entry.subscription)?.();
  disconnectListeners.delete(entry.subscription);
  try {
    entry.connection.destroy();
  } catch (error) {
    // Already destroyed (kicked, moved, network) — the session is gone either
    // way, and throwing here would strand the transcript we just built.
    logger.debug("Voice connection was already destroyed:", error);
  }
  return attachment;
}

/**
 * Leave any session that has received no voice for IDLE_TIMEOUT_MS.
 *
 * Idleness is measured on speech, not on who is in the channel — see
 * `TranscriptionService.lastActivity`. The transcript is still uploaded, so a
 * meeting everybody walked away from leaves its file behind.
 */
async function sweepIdleSessions() {
  const timeout = config.IDLE_TIMEOUT_MS;
  if (timeout <= 0) return;

  for (const [guildId, entry] of activeTranscriptions.entries()) {
    const idleMs = transcriptionService.idleMs(entry.subscription);
    if (idleMs < timeout) continue;

    if (entry.closing) continue; // a stop is already draining this one
    activeTranscriptions.markClosing(guildId, entry.subscription);
    const minutes = Math.round(idleMs / 60000);
    console.log(`Leaving guild ${guildId}: no voice for ${minutes} minutes`);

    try {
      const attachment = await closeSession(entry);
      activeTranscriptions.deleteIf(guildId, entry.subscription);
      const channel = entry.textChannel;
      if (channel && "send" in channel) {
        await channel
          .send({
            content:
              `Transcription stopped: nobody has spoken for ${minutes} minutes.` +
              (attachment ? "" : " Nothing was transcribed."),
            ...(attachment ? { files: [attachment] } : {}),
          })
          .catch((error: unknown) =>
            console.error("Error announcing the idle stop:", error)
          );
      }
    } catch (error) {
      console.error(`Error closing the idle session in guild ${guildId}:`, error);
    }
  }
}

/** `/transcriber stop` — drain, upload the transcript, then leave. */
async function handleStop(interaction: ChatInputCommandInteraction) {
  // Guaranteed by the `inGuild()` check in the dispatcher; narrowing it there
  // does not survive the call, so it is restated rather than asserted away.
  const guildId = interaction.guildId;
  if (!guildId) return;


  const transcription = activeTranscriptions.get(guildId);
  if (!transcription) {
    // No entry, but the bot may still be sitting in a voice channel: a session
    // whose entry was lost is otherwise unreachable — no command can stop it,
    // the idle sweep cannot see it, and only a restart clears it. Leaving the
    // channel is always the right answer to "stop", so say so and do it.
    const stray = getVoiceConnection(guildId);
    if (stray) {
      logger.warn(`Guild ${guildId} had a voice connection with no session entry`);
      try {
        stray.destroy();
      } catch (error) {
        logger.debug("Stray voice connection was already destroyed:", error);
      }
      await interaction.reply({
        content:
          "There was no transcription session on record, but I was still in a " +
          "voice channel, so I have left it. No transcript could be recovered.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interaction.reply({
      content: "There is no active transcription to stop.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (transcription.closing) {
    await interaction.reply({
      content: "This server's transcription is already stopping.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // Marked, not removed. A second `/transcriber stop` is refused above, and a
  // `/transcriber start` arriving during the drain is refused too — the entry
  // used to be deleted here, which left the guild looking free for the 20 s
  // the vendor took, and a session started in that gap shared the very voice
  // connection this stop was about to destroy.
  activeTranscriptions.markClosing(guildId, transcription.subscription);

  // Mandatory, not defensive: the drain below waits up to 20 s for the last
  // transcripts, and an interaction must be acknowledged within 3 s. Replying
  // straight away would lose the very file this command exists to produce.
  // Deferring buys 15 minutes, which the 20 s drain fits inside comfortably.
  await interaction.deferReply();

  const attachment = await closeSession(transcription, () => {
    void interaction
      .editReply("*Stopping — waiting for the last transcripts…*")
      .catch(() => {});
  });
  activeTranscriptions.deleteIf(guildId, transcription.subscription);

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
  // Guaranteed by the `inGuild()` check in the dispatcher; narrowing it there
  // does not survive the call, so it is restated rather than asserted away.
  const guildId = interaction.guildId;
  if (!guildId) return;


  const summary = usageStore.summary(
    config.BUDGET_PERIOD,
    guildId ?? undefined
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
