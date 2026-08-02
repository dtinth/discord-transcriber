import { FrameProcessor, NonRealTimeVAD } from "@ricky0123/vad-node";
import type { TextBasedChannel } from "discord.js";
import { Buffer } from "node:buffer";
import prism from "prism-media";
import type { AsrSetup } from "./asr-setup.ts";
import config from "./config.ts";
import { Downsampler } from "./downsample.ts";
import logger from "./logger.ts";
import { Utterance } from "./utterance.ts";

/** Bytes per Silero VAD frame: 1024 samples of 16 kHz 16-bit mono (64 ms). */
const VAD_FRAME_BYTES = 1024 * 2;

/**
 * Audio kept from just before speech was detected, so the first syllable —
 * the one that triggered the VAD — is not clipped off the utterance.
 * 320 ms of 16 kHz 16-bit mono.
 */
const PRE_ROLL_BYTES = 10240;

/**
 * Processes one user's live audio: decodes opus, downsamples once to the
 * 16 kHz mono format that both the VAD and vxasr consume, segments speech
 * with Silero VAD, and routes the audio of each segment into an
 * {@link Utterance}.
 */
/** What the stream needs from a speech segment. */
export interface SpeechSegment {
  addAudioData(pcm: Buffer): void;
  finalize(): void;
}

/**
 * Seam for tests: segmentation is decided here, but an {@link Utterance} talks
 * to Discord and starts a vendor session. Tests substitute a recorder so the
 * VAD path can be exercised against real audio with no network and no channel.
 */
export type SegmentFactory = (userId: string) => SpeechSegment;

export class UserAudioStream {
  private opusDecoder: prism.opus.Decoder;
  private downsampler = new Downsampler();
  private vadInstance: NonRealTimeVAD | null = null;
  private currentUtterance: SpeechSegment | null = null;
  private isProcessing = false;
  private isSpeaking = false;
  private destroyed = false;

  /** Pending 16 kHz mono PCM not yet consumed as full VAD frames. */
  private vadBuffer: Buffer = Buffer.alloc(0);
  /** Recent 16 kHz mono PCM kept while not speaking (see PRE_ROLL_BYTES). */
  private preRoll: Buffer[] = [];
  private preRollBytes = 0;

  private inactivityTimeout = 1500; // ms
  private lastSpeechTime = 0;
  private activationThreshold = config.ACTIVATION_THRESHOLD;
  private deactivationThreshold = config.DEACTIVATION_THRESHOLD;
  private silenceDuration = config.SILENCE_DURATION;

  constructor(
    private userId: string,
    private streamKey: string,
    private textChannel: TextBasedChannel,
    private audioStream: any,
    private asr: AsrSetup,
    private onEnd: () => void,
    private createSegment: SegmentFactory = (userId) =>
      new Utterance(userId, textChannel, asr)
  ) {
    this.opusDecoder = new prism.opus.Decoder({
      rate: 48000,
      channels: 2,
      frameSize: 960,
    });

    this.initializeVAD()
      .then(() => {
        this.processAudioStream();
      })
      .catch((error) => {
        logger.error("Error initializing VAD:", error);
        this.destroy();
      });
  }

  private async initializeVAD() {
    this.vadInstance = await NonRealTimeVAD.new({
      frameSamples: 1024, // Standard frame size for Silero VAD
      positiveSpeechThreshold: 0.5,
      negativeSpeechThreshold: 0.3,
    });
    logger.info(`VAD initialized for user ${this.userId}`);
  }

  /**
   * Decode and process the stream chunk by chunk using async iteration.
   */
  private async processAudioStream() {
    try {
      this.isProcessing = true;
      this.audioStream.pipe(this.opusDecoder);
      this.scheduleInactivityCheck();

      try {
        for await (const chunk of this.opusDecoder) {
          if (!this.isProcessing) break;
          await this.processAudioChunk(chunk as Buffer);
        }
      } catch (streamError) {
        logger.error(`Stream error for user ${this.userId}:`, streamError);
      }

      logger.info(`Audio stream ended for user ${this.userId}`);
      this.destroy();
    } catch (error) {
      logger.error(
        `Error processing audio stream for user ${this.userId}:`,
        error
      );
      this.destroy();
    }
  }

  /**
   * One decoded chunk: downsample once, route to the current utterance (or
   * the pre-roll), and run the VAD state machine over full frames.
   */
  private async processAudioChunk(chunk: Buffer) {
    try {
      const pcm16k = this.downsampler.push(chunk);
      if (pcm16k.length === 0) return;

      if (this.isSpeaking && this.currentUtterance) {
        this.currentUtterance.addAudioData(pcm16k);
      } else {
        this.pushPreRoll(pcm16k);
      }

      if (!this.vadInstance) return;

      this.vadBuffer = Buffer.concat([this.vadBuffer, pcm16k]);
      while (this.vadBuffer.length >= VAD_FRAME_BYTES) {
        const frame = this.vadBuffer.subarray(0, VAD_FRAME_BYTES);
        this.vadBuffer = this.vadBuffer.subarray(VAD_FRAME_BYTES);
        await this.processVadFrame(frame);
      }
    } catch (error) {
      logger.error(
        `Error processing audio chunk for user ${this.userId}:`,
        error
      );
    }
  }

  /** Run one 1024-sample frame through the VAD and the speech state machine. */
  private async processVadFrame(frame: Buffer) {
    const float32Data = new Float32Array(frame.length / 2);
    for (let i = 0; i < float32Data.length; i++) {
      float32Data[i] = frame.readInt16LE(i * 2) / 32768;
    }

    const frameProcessor = this.vadInstance!.frameProcessor as FrameProcessor;
    const result = await frameProcessor.modelProcessFunc(float32Data);
    const speechConfidence = result.isSpeech;
    logger.debug(`Speech confidence: ${speechConfidence.toFixed(3)}`);

    // Hysteresis: a higher threshold to start speaking than to keep speaking,
    // so confidence hovering around one threshold cannot toggle rapidly.
    const speechDetected = this.isSpeaking
      ? speechConfidence >= this.deactivationThreshold
      : speechConfidence >= this.activationThreshold;

    if (speechDetected) {
      this.lastSpeechTime = Date.now();

      if (!this.isSpeaking) {
        this.isSpeaking = true;
        logger.info(`Speech start detected for user ${this.userId}`);

        this.currentUtterance = this.createSegment(this.userId);

        // Seed the utterance with the pre-roll so the syllable that woke the
        // VAD is part of the recording.
        for (const buffer of this.preRoll) {
          this.currentUtterance.addAudioData(buffer);
        }
        this.preRoll = [];
        this.preRollBytes = 0;
      }
    } else if (this.isSpeaking) {
      const silence = Date.now() - this.lastSpeechTime;
      if (silence > this.silenceDuration) {
        logger.info(`Speech end detected for user ${this.userId}`);
        this.endUtterance();
      }
    }
  }

  private endUtterance() {
    this.isSpeaking = false;
    if (this.currentUtterance) {
      this.currentUtterance.finalize();
      this.currentUtterance = null;
    }
  }

  private pushPreRoll(pcm: Buffer) {
    this.preRoll.push(pcm);
    this.preRollBytes += pcm.length;
    while (
      this.preRoll.length > 0 &&
      this.preRollBytes - this.preRoll[0].length >= PRE_ROLL_BYTES
    ) {
      this.preRollBytes -= this.preRoll[0].length;
      this.preRoll.shift();
    }
  }

  /**
   * Finalize a stale utterance when speech confidence never formally dropped
   * but no speech has been detected for a while.
   */
  private scheduleInactivityCheck() {
    const interval = setInterval(() => {
      if (!this.isProcessing) {
        clearInterval(interval);
        return;
      }

      if (this.isSpeaking && this.currentUtterance) {
        const silence = Date.now() - this.lastSpeechTime;
        if (silence > this.inactivityTimeout) {
          logger.info(
            `Finalizing utterance due to inactivity for user ${this.userId}`
          );
          this.endUtterance();
        }
      }
    }, 500);
  }

  public destroy() {
    // Idempotent: destroy runs from the stream's error path, its end path, and
    // the service teardown, and `onEnd` releases this user's slot in the
    // service's active set. Letting it run twice would release a slot that a
    // *newer* stream for the same user now owns, and the service would then
    // start a second concurrent stream for that speaker.
    if (this.destroyed) return;
    this.destroyed = true;

    this.isProcessing = false;
    this.endUtterance();

    if (this.audioStream) {
      try {
        this.audioStream.destroy();
      } catch (error) {
        logger.error("Error destroying audio stream:", error);
      }
    }

    this.onEnd();
  }
}
