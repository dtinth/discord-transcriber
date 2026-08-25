import { EndBehaviorType, VoiceConnection } from "@discordjs/voice";
import type { TextBasedChannel } from "discord.js";
import type { AsrSetup } from "./asr-setup.ts";
import { budgetMessage, checkBudget, type BudgetLimits } from "./budget.ts";
import config from "./config.ts";
import logger from "./logger.ts";
import { SpeakerRegistry } from "./speaker-registry.ts";
import type { UsageStore } from "./usage-store.ts";
import { UserAudioStream } from "./user-audio-stream.ts";

export interface TranscriptionSessionOptions {
  /** Who ran `!transcribe` — recorded against every row this session bills. */
  requesterId: string | null;
}

export class TranscriptionService {
  /** One registry per transcription session, keyed by subscription id. */
  private sessions: Map<string, SpeakerRegistry> = new Map();
  private transcriptionChannels: Map<string, TextBasedChannel> = new Map();

  constructor(
    private asr: AsrSetup,
    private usage?: UsageStore,
    private limits?: BudgetLimits
  ) {}

  createTranscriptionStream(
    connection: VoiceConnection,
    textChannel: TextBasedChannel,
    options: TranscriptionSessionOptions = { requesterId: null }
  ) {
    const receiver = connection.receiver;
    // Discord allows a user one voice connection per guild, so (guild, speaker)
    // *is* the identity of an audio stream — a stabler key for vendor session
    // reuse than anything scoped to a single `!transcribe` session, and it
    // cannot collide across guilds.
    const guildId = connection.joinConfig.guildId;

    // Create a subscription ID to track this transcription session
    // Random rather than `Date.now()`: two guilds starting transcription in the
    // same millisecond would otherwise share this session's map entry, and
    // stopping one would tear down the other's streams.
    const subscriptionId = crypto.randomUUID();

    // Store the text channel for sending transcriptions
    this.transcriptionChannels.set(subscriptionId, textChannel);

    // Tracks which speakers already have a live stream (see SpeakerRegistry)
    const speakers = new SpeakerRegistry();
    this.sessions.set(subscriptionId, speakers);

    const channelId = "id" in textChannel ? (textChannel.id as string) : null;
    /** Said once per session, so a spent budget does not spam the channel. */
    let budgetNoticeSent = false;

    receiver.speaking.on("start", (userId) => {
      logger.debug(`User ${userId} started speaking`);

      // Checked before the utterance opens a vendor session — the only moment
      // refusing is free. Stopping mid-flight would mean paying for audio the
      // vendor already processed and discarding the transcript anyway.
      if (this.usage && this.limits) {
        const verdict = checkBudget(this.usage, this.limits, guildId);
        if (!verdict.allowed) {
          if (!budgetNoticeSent) {
            budgetNoticeSent = true;
            logger.warn(
              `Budget reached (${verdict.scope}): $${verdict.spentUsd.toFixed(4)} ` +
                `of $${verdict.limitUsd.toFixed(2)} — transcription paused`
            );
            if ("send" in textChannel) {
              void textChannel
                .send(budgetMessage(verdict))
                .catch((error) => logger.error("Error sending budget notice:", error));
            }
          }
          return;
        }
      }

      let audioStream: { destroy?: () => void } | undefined;
      try {
        speakers.start(userId, (onEnd) => {
          audioStream = receiver.subscribe(userId, {
            end: {
              behavior: EndBehaviorType.AfterSilence,
              duration: config.RECEIVER_SILENCE_MS,
            },
          });

          return new UserAudioStream(
            userId,
            config.ASR_SESSION_REUSE ? `${guildId}_${userId}` : undefined,
            textChannel,
            audioStream,
            this.asr,
            onEnd,
            this.usage && {
              recordAttempt: (info) =>
                this.usage!.record({
                  at: Date.now(),
                  guildId,
                  channelId,
                  speakerId: info.speakerId,
                  requesterId: options.requesterId,
                  configurationId: info.configurationId,
                  attempt: info.attempt,
                  audioSeconds: info.audioSeconds,
                  costUsd: info.costUsd,
                  ok: info.ok,
                  error: info.error,
                }),
            }
          );
        });
      } catch (error) {
        // The registry has already released this speaker, so a later utterance
        // still gets a fresh attempt. Just log it and drop the half-open
        // subscription rather than leaking it.
        logger.error(`Failed to start audio stream for user ${userId}:`, error);
        try {
          audioStream?.destroy?.();
        } catch (cleanupError) {
          logger.error("Error destroying audio stream:", cleanupError);
        }
      }
    });

    return subscriptionId;
  }

  stopTranscription(subscriptionId: string) {
    const speakers = this.sessions.get(subscriptionId);
    if (speakers) {
      speakers.destroyAll((error) =>
        logger.error("Error destroying user audio stream:", error)
      );
      this.sessions.delete(subscriptionId);
    }

    // Clean up the channel reference
    this.transcriptionChannels.delete(subscriptionId);
  }
}
