import { EndBehaviorType, VoiceConnection } from "@discordjs/voice";
import type { TextBasedChannel } from "discord.js";
import type { AsrSetup } from "./asr-setup.ts";
import logger from "./logger.ts";
import { UserAudioStream } from "./user-audio-stream.ts";

export class TranscriptionService {
  private activeStreams: Map<string, UserAudioStream> = new Map();
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

    // Track active users to avoid duplicate subscriptions
    const activeUsers = new Set<string>();

    // Set up audio receiving
    receiver.speaking.on("start", (userId) => {
      logger.debug(`User ${userId} started speaking`);

      // Skip if we already have an active stream for this user
      const streamKey = `${subscriptionId}_${userId}`;
      if (activeUsers.has(userId)) {
        return;
      }

      // Mark user as active
      activeUsers.add(userId);

      // Create audio subscription
      const audioStream = receiver.subscribe(userId, {
        end: {
          behavior: EndBehaviorType.AfterSilence,
          duration: 2000,
        },
      });

      // Create a new audio stream processor
      const userStream = new UserAudioStream(
        userId,
        streamKey,
        textChannel,
        audioStream,
        this.asr,
        () => {
          // Cleanup function
          this.activeStreams.delete(streamKey);
          activeUsers.delete(userId);
        }
      );

      // Store the stream processor
      this.activeStreams.set(streamKey, userStream);
    });

    return subscriptionId;
  }

  stopTranscription(subscriptionId: string) {
    // Close all active streams for this subscription
    for (const [key, stream] of this.activeStreams.entries()) {
      if (key.startsWith(`${subscriptionId}_`)) {
        stream.destroy();
        this.activeStreams.delete(key);
      }
    }

    // Clean up the channel reference
    this.transcriptionChannels.delete(subscriptionId);
  }
}
