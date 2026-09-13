import type { TextBasedChannel } from "discord.js";
import { Buffer } from "node:buffer";
import { writeWav } from "vxasr/audio";
import type { AsrSetup } from "./asr-setup.ts";
import logger from "./logger.ts";
import type { RecordingSink } from "./recording-archive.ts";
import { Recording } from "./recording.ts";
import { ThrottledMessageUpdater } from "./throttled-message-updater.ts";
import { runTranscriptionJob } from "./transcription-job.ts";

export interface TranscriptRow {
  startedAt: number;
  endedAt: number;
  messageId: string | null;
  speakerId: string;
  text: string;
}

/**
 * Where a session collects its utterances.
 *
 * Start and finish are both reported, and every utterance reports exactly one
 * finish — including the silent ones, which contribute no row. That symmetry is
 * what lets `!stop` know whether anything is still at the vendor; a sink that
 * only heard about successes would wait for utterances that already gave up.
 */
export interface TranscriptSink {
  utteranceStarted(): void;
  /** `row` is null when the utterance produced no transcript worth keeping. */
  utteranceFinished(row: TranscriptRow | null): void;
}

/** Where an utterance reports what each attempt cost. */
export interface UsageSink {
  recordAttempt(info: {
    speakerId: string;
    configurationId: string;
    attempt: number;
    audioSeconds: number;
    costUsd: number;
    ok: boolean;
    error?: string;
  }): void;
}

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
  /** When the speaker began; the transcript is ordered by this. */
  private readonly startedAt = Date.now();
  private endedAt = 0;
  private reported = false;
  private updater: ThrottledMessageUpdater;
  private abort = new AbortController();
  private finalized = false;

  constructor(
    private readonly userId: string,
    textChannel: TextBasedChannel,
    asr: AsrSetup,
    /** Groups this speaker's utterances for vendor session reuse. */
    private clientId?: string,
    /** Receives the cost of every attempt, successful or not. */
    private usage?: UsageSink,
    /** Receives this utterance once it is transcribed (or finally failed). */
    private transcript?: TranscriptSink,
    private recordings?: RecordingSink
  ) {
    this.updater = new ThrottledMessageUpdater(userId, textChannel);
    this.transcript?.utteranceStarted();
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
    this.endedAt = Date.now();
    this.recording.end();

    if (this.recording.size === 0) {
      // Nothing was ever recorded (e.g. torn down right after speech start).
      // Don't ask a vendor to transcribe zero bytes — just clean up.
      this.abort.abort();
      void this.updater.noSpeech();
      void this.report(this.userId, null);
      return;
    }

    this.updater.setStatus("Transcribing...");
  }

  /**
   * Sends this utterance's audio to the archive, if one is configured.
   *
   * Never throws: an archive that is misconfigured or unreachable must not
   * cost anybody their transcript, which is the part that cannot be rebuilt.
   */
  private archiveRecording(userId: string, messageId: string | null): void {
    if (!this.recordings || this.recording.size === 0) return;
    try {
      this.recordings.archive({
        speakerId: userId,
        startedAt: this.startedAt,
        endedAt: this.endedAt || Date.now(),
        messageId,
        wav: writeWav(this.recording.toBuffer()),
        seconds: this.recording.size / 32000,
      });
    } catch (error) {
      logger.error("Error archiving the utterance recording:", error);
    }
  }

  /**
   * Hands this utterance to the session transcript. Never throws, and reports
   * exactly once — a missed finish would leave `!stop` waiting for it.
   */
  private async report(userId: string, text: string | null): Promise<void> {
    if (!this.transcript || this.reported) return;
    this.reported = true;
    try {
      const messageId = await this.updater.messageId();
      // Archived here because this is the one place every utterance passes
      // through, whatever its outcome — so an utterance that failed every
      // attempt keeps its audio, which is exactly the one worth re-running.
      // Silent utterances (text === null) are skipped: their message is
      // deleted and they are absent from the transcript, so an object for
      // them would index nothing.
      if (text !== null) this.archiveRecording(userId, messageId);
      this.transcript.utteranceFinished(
        text === null
          ? null
          : {
              startedAt: this.startedAt,
              endedAt: this.endedAt || Date.now(),
              messageId,
              speakerId: userId,
              text,
            }
      );
    } catch (error) {
      logger.error("Error recording the utterance for the transcript:", error);
      // The count must still fall, or `!stop` waits for an utterance that is
      // already finished.
      try {
        this.transcript.utteranceFinished(null);
      } catch {
        // Nothing further can be done here.
      }
    }
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
        onAttemptFinished: ({ attempt, configurationId, usage, ok, error }) => {
          // Recorded per attempt, so a retry's failed tries are billed to the
          // ledger too — the job's return value only carries the winner's.
          this.usage?.recordAttempt({
            speakerId: userId,
            configurationId,
            attempt,
            audioSeconds: this.recording.size / 32000,
            costUsd: usage.reduce((sum, r) => sum + r.unitPrice * r.quantity, 0),
            ok,
            error,
          });
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
        await this.report(userId, text);
      } else {
        // Nothing was said: the message is deleted, and no row is added — but
        // the finish is still reported, or `!stop` would wait for it.
        await this.updater.noSpeech();
        await this.report(userId, null);
      }

      const cost = result.usage.reduce(
        (sum, record) => sum + record.unitPrice * record.quantity,
        0
      );
      // Audio tokens are logged because they make session reuse observable:
      // on a reused connection the vendor re-processes prior turns, so this
      // number climbs across a speaker's utterances instead of tracking only
      // the length of the current one.
      const audioTokens = result.usage
        .filter((record) => record.sku.endsWith("input-audio-tokens"))
        .reduce((sum, record) => sum + record.quantity, 0);
      logger.info(
        `Transcribed ${(this.recording.size / 32000).toFixed(1)}s for ${userId} ` +
          `via ${result.configurationId} (attempt ${result.attempt}, ` +
          `$${cost.toFixed(6)}, ${audioTokens} audio tokens)`
      );
    } catch (error) {
      if (this.abort.signal.aborted) return;
      logger.error(`Transcription failed for ${userId}:`, error);
      // Attach the audio so the sound is not lost with the transcript.
      const wav =
        this.recording.size > 0 ? writeWav(this.recording.toBuffer()) : undefined;
      await this.updater.fail(wav);
      // Recorded with empty text: the transcript should show *that something
      // was said here and we do not have it*, rather than omit the gap.
      await this.report(userId, "");
    }
  }
}
