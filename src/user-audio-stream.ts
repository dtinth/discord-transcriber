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

/** How much audio one VAD frame represents. */
const VAD_FRAME_MS = (1024 / 16000) * 1000;

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

  /**
   * Two clocks, because two different questions are being asked.
   *
   * `audioMs` counts the audio the VAD has actually consumed, and decides when
   * a speaker paused. That has to be measured in audio: a pause is a property
   * of what was said, so it must not change with how the packets happened to
   * arrive. Measuring it with `Date.now()` made utterance boundaries depend on
   * network timing — a burst after a reconnect would run two sentences
   * together, and a stall would split one in half.
   *
   * `lastChunkAt` is wall-clock, and answers the opposite question: has audio
   * stopped *arriving*? Nothing but real time can answer that — when a stream
   * stalls, the audio clock stalls with it, so an audio-only design would hold
   * a half-finished utterance open for ever.
   */
  private audioMs = 0;
  private lastSpeechAudioMs = 0;
  /** Audio position where the open utterance began, for {@link maxUtteranceMs}. */
  private utteranceStartedAtMs = 0;
  private lastChunkAt = Date.now();

  /** Wall-clock silence that means the stream itself stopped delivering. */
  private inactivityTimeout = config.STALL_TIMEOUT_MS;
  private activationThreshold = config.ACTIVATION_THRESHOLD;
  private deactivationThreshold = config.DEACTIVATION_THRESHOLD;
  private silenceDuration = config.SILENCE_DURATION;

  constructor(
    private userId: string,
    /**
     * Identifies this speaker for vendor session reuse. Undefined disables it.
     */
    private clientId: string | undefined,
    private textChannel: TextBasedChannel,
    private audioStream: any,
    private asr: AsrSetup,
    private onEnd: () => void,
    private createSegment: SegmentFactory = (userId) =>
      new Utterance(userId, textChannel, asr, clientId),
    private maxUtteranceMs: number = config.MAX_UTTERANCE_MS
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
      // Audio arrived, whatever it contains — this is the stall detector's
      // input, and it must be updated even for a chunk that decodes to nothing.
      this.lastChunkAt = Date.now();

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
    this.audioMs += VAD_FRAME_MS;

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
      this.lastSpeechAudioMs = this.audioMs;

      if (!this.isSpeaking) {
        this.isSpeaking = true;
        logger.info(`Speech start detected for user ${this.userId}`);

        this.currentUtterance = this.createSegment(this.userId);
        this.utteranceStartedAtMs = this.audioMs;

        // Seed the utterance with the pre-roll so the syllable that woke the
        // VAD is part of the recording.
        for (const buffer of this.preRoll) {
          this.currentUtterance.addAudioData(buffer);
        }
        this.preRoll = [];
        this.preRollBytes = 0;
      }
      // Speech that never pauses would otherwise grow one utterance without
      // limit. Split it and carry straight on, so the audio is all still
      // transcribed — just as two messages rather than one endless one.
      if (this.audioMs - this.utteranceStartedAtMs >= this.maxUtteranceMs) {
        logger.info(
          `Splitting a long utterance for user ${this.userId} at ` +
            `${(this.maxUtteranceMs / 1000).toFixed(0)}s`
        );
        this.currentUtterance?.finalize();
        this.currentUtterance = this.createSegment(this.userId);
        this.utteranceStartedAtMs = this.audioMs;
      }
    } else if (this.isSpeaking) {
      const silence = this.audioMs - this.lastSpeechAudioMs;
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
   * Close an utterance that the audio clock can no longer close, because audio
   * stopped arriving at all — a muted speaker, a dropped connection, a stalled
   * stream. Deliberately wall-clock: when no packets arrive, no audio is
   * consumed, so the silence rule in `processVadFrame` never advances and the
   * utterance would hang open with its transcript never requested.
   */
  private scheduleInactivityCheck() {
    const interval = setInterval(() => {
      if (!this.isProcessing) {
        clearInterval(interval);
        return;
      }

      if (this.isSpeaking && this.currentUtterance) {
        const stalledFor = Date.now() - this.lastChunkAt;
        if (stalledFor > this.inactivityTimeout) {
          logger.info(
            `Finalizing utterance for user ${this.userId}: no audio for ${stalledFor}ms`
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
