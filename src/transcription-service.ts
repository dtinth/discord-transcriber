import { EndBehaviorType, VoiceConnection } from "@discordjs/voice";
import { AttachmentBuilder, type TextBasedChannel } from "discord.js";
import type { AsrSetup } from "./asr-setup.ts";
import { budgetMessage, checkBudget, type BudgetLimits } from "./budget.ts";
import config from "./config.ts";
import logger from "./logger.ts";
import { PendingUtterances } from "./pending-utterances.ts";
import { SessionTranscript } from "./session-transcript.ts";
import { SpeakerRegistry } from "./speaker-registry.ts";
import type { UsageStore } from "./usage-store.ts";
import { UserAudioStream } from "./user-audio-stream.ts";

export interface TranscriptionSessionOptions {
  /** Who ran `!transcribe` — recorded against every row this session bills. */
  requesterId: string | null;
}

/**
 * How long `!stop` waits for transcriptions that are still at the vendor.
 *
 * The final utterance is nearly always in flight when somebody stops the bot,
 * and that is usually the part they wanted. Waiting is bounded so a stalled
 * vendor cannot hold the file for ever.
 */
const DRAIN_TIMEOUT_MS = 20_000;

export class TranscriptionService {
  /** One registry per transcription session, keyed by subscription id. */
  private sessions: Map<string, SpeakerRegistry> = new Map();
  /** What each session has transcribed so far, for the CSV on `!stop`. */
  private transcripts: Map<string, SessionTranscript> = new Map();
  /** Utterances still awaiting a transcript, per session. */
  private pending: Map<string, PendingUtterances> = new Map();
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

    const transcript = new SessionTranscript();
    this.transcripts.set(subscriptionId, transcript);
    const pending = new PendingUtterances();
    this.pending.set(subscriptionId, pending);

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
            },
            {
              utteranceStarted: () => pending.started(),
              utteranceFinished: (row) => {
                pending.finished();
                if (!row) return;
                transcript.add({
                  ...row,
                  speakerName: displayName(textChannel, row.speakerId),
                });
              },
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

  /**
   * Finalizes the session and returns its transcript as a CSV attachment.
   *
   * Waits, briefly, for utterances still at the vendor: the last thing said is
   * almost always in flight when somebody types `!stop`, and a file missing the
   * end of the meeting is the wrong file. Bounded, so a stalled vendor delays
   * the upload rather than preventing it.
   *
   * Returns null when the session produced nothing worth sending.
   */
  async finishAndBuildTranscript(
    subscriptionId: string,
    onWaiting?: () => void
  ): Promise<AttachmentBuilder | null> {
    const transcript = this.transcripts.get(subscriptionId);
    if (!transcript) return null;

    // Close every open utterance first, so what is in flight is all there is.
    this.sessions.get(subscriptionId)?.destroyAll((error) =>
      logger.error("Error destroying user audio stream:", error)
    );

    const pending = this.pending.get(subscriptionId);
    if (pending && pending.size > 0) {
      onWaiting?.();
      const left = await pending.drain(DRAIN_TIMEOUT_MS);
      if (left > 0) {
        logger.warn(
          `Transcript: ${left} utterance(s) did not finish within ` +
            `${DRAIN_TIMEOUT_MS}ms and are missing from the file`
        );
      }
    }

    if (transcript.size === 0) return null;

    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    return new AttachmentBuilder(Buffer.from(transcript.toCsv(), "utf8"), {
      name: `transcript-${stamp}.csv`,
    });
  }

  /**
   * What a session currently has in flight.
   *
   * `speakers` are people whose audio is being segmented right now;
   * `pendingUtterances` are utterances already sent to the vendor and still
   * waiting for a transcript. Both must be zero before a restart is free —
   * anything in either column is audio that a restart would throw away.
   */
  sessionStats(subscriptionId: string): {
    speakers: number;
    pendingUtterances: number;
    transcribed: number;
  } {
    return {
      speakers: this.sessions.get(subscriptionId)?.size ?? 0,
      pendingUtterances: this.pending.get(subscriptionId)?.size ?? 0,
      transcribed: this.transcripts.get(subscriptionId)?.size ?? 0,
    };
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
    this.transcripts.delete(subscriptionId);
    this.pending.delete(subscriptionId);
  }
}

/**
 * The speaker's display name, read from the guild cache.
 *
 * Deliberately cache-only and synchronous: this runs once per utterance while
 * a session is live, and awaiting a fetch here would add a network round trip
 * to the transcription path. A name that is not cached falls back to the id,
 * which is still a usable record — the id is what identifies the person.
 */
function displayName(channel: TextBasedChannel, userId: string): string {
  try {
    const guild = "guild" in channel ? channel.guild : undefined;
    const member = guild?.members?.cache?.get(userId);
    return member?.displayName ?? member?.user?.username ?? userId;
  } catch {
    return userId;
  }
}
