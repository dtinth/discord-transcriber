import { EndBehaviorType, VoiceConnection } from "@discordjs/voice";
import type { TextBasedChannel } from "discord.js";
import type { AsrSetup } from "./asr-setup.ts";
import logger from "./logger.ts";
import { SpeakerRegistry } from "./speaker-registry.ts";
import { UserAudioStream } from "./user-audio-stream.ts";

export class TranscriptionService {
  /** One registry per transcription session, keyed by subscription id. */
  private sessions: Map<string, SpeakerRegistry> = new Map();
  private transcriptionChannels: Map<string, TextBasedChannel> = new Map();

  constructor(private asr: AsrSetup) {}

  createTranscriptionStream(
    connection: VoiceConnection,
    textChannel: TextBasedChannel
  ) {
    const receiver = connection.receiver;

    // Create a subscription ID to track this transcription session
    const subscriptionId = Date.now().toString();

    // Store the text channel for sending transcriptions
    this.transcriptionChannels.set(subscriptionId, textChannel);

    // Tracks which speakers already have a live stream (see SpeakerRegistry)
    const speakers = new SpeakerRegistry();
    this.sessions.set(subscriptionId, speakers);

    receiver.speaking.on("start", (userId) => {
      logger.debug(`User ${userId} started speaking`);

      let audioStream: { destroy?: () => void } | undefined;
      try {
        speakers.start(userId, (onEnd) => {
          audioStream = receiver.subscribe(userId, {
            end: {
              behavior: EndBehaviorType.AfterSilence,
              duration: 2000,
            },
          });

          return new UserAudioStream(
            userId,
            `${subscriptionId}_${userId}`,
            textChannel,
            audioStream,
            this.asr,
            onEnd
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
