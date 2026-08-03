import type { TextBasedChannel } from "discord.js";
import { Buffer } from "node:buffer";
import { writeWav } from "vxasr/audio";
import type { AsrSetup } from "./asr-setup.ts";
import logger from "./logger.ts";
import { Recording } from "./recording.ts";
import { ThrottledMessageUpdater } from "./throttled-message-updater.ts";
import { runTranscriptionJob } from "./transcription-job.ts";

/**
 * One speech segment: a growing {@link Recording}, a Discord message, and a
 * transcription job running against them.
 *
 * The job starts the moment the utterance is created — while the person is
 * still speaking — so a streaming provider can put partial text on screen
 * during the speech, and a batch-style provider has its socket warm by the
 * time the segment ends.
 */
export class Utterance {
  private recording = new Recording();
  private updater: ThrottledMessageUpdater;
  private abort = new AbortController();
  private finalized = false;

  constructor(
    userId: string,
    textChannel: TextBasedChannel,
    asr: AsrSetup,
    /** Groups this speaker's utterances for vendor session reuse. */
    private clientId?: string
  ) {
    this.updater = new ThrottledMessageUpdater(userId, textChannel);
    void this.runJob(userId, asr);
  }

  /** Add 16 kHz 16-bit mono PCM. Ignored after finalize. */
  addAudioData(pcm: Buffer): void {
    if (this.finalized) return;
    this.recording.append(pcm);
  }

  /** The speech segment ended; no more audio will arrive. Idempotent. */
  finalize(): void {
    if (this.finalized) return;
    this.finalized = true;
    this.recording.end();

    if (this.recording.size === 0) {
      // Nothing was ever recorded (e.g. torn down right after speech start).
      // Don't ask a vendor to transcribe zero bytes — just clean up.
      this.abort.abort();
      void this.updater.noSpeech();
      return;
    }

    this.updater.setStatus("Transcribing...");
  }

  private async runJob(userId: string, asr: AsrSetup): Promise<void> {
    try {
      const result = await runTranscriptionJob({
        recording: this.recording,
        configurations: asr.configurations,
        env: asr.env,
        clientId: this.clientId,
        signal: this.abort.signal,
        onPartial: (text) => {
          if (text.trim()) this.updater.setPartial(text.trim());
        },
        onAttemptStart: (attempt, configurationId) => {
          logger.info(
            `Utterance for ${userId}: attempt ${attempt} via ${configurationId}`
          );
          if (attempt > 1) this.updater.setStatus(`Retrying (attempt ${attempt})...`);
        },
      });

      const text = result.text.trim();
      if (text) {
        await this.updater.finalize(text);
      } else {
        await this.updater.noSpeech();
      }

      const cost = result.usage.reduce(
        (sum, record) => sum + record.unitPrice * record.quantity,
        0
      );
      logger.info(
        `Transcribed ${(this.recording.size / 32000).toFixed(1)}s for ${userId} ` +
          `via ${result.configurationId} (attempt ${result.attempt}, $${cost.toFixed(6)})`
      );
    } catch (error) {
      if (this.abort.signal.aborted) return;
      logger.error(`Transcription failed for ${userId}:`, error);
      // Attach the audio so the sound is not lost with the transcript.
      const wav =
        this.recording.size > 0 ? writeWav(this.recording.toBuffer()) : undefined;
      await this.updater.fail(wav);
    }
  }
}
