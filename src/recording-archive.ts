import logger from "./logger.ts";
import type { ObjectStorage } from "./object-storage.ts";
import { PendingUtterances } from "./pending-utterances.ts";
import { csvField } from "./session-transcript.ts";

/** One archived utterance, as the session's index reports it. */
export interface ArchivedRecording {
  messageId: string | null;
  speakerId: string;
  startedAt: number;
  endedAt: number;
  seconds: number;
  bytes: number;
  key: string;
}

/** What an utterance hands over once its audio is complete. */
export interface RecordingUpload {
  speakerId: string;
  startedAt: number;
  endedAt: number;
  messageId: string | null;
  wav: Uint8Array;
  seconds: number;
}

/** Where an utterance sends its audio. Implemented by {@link RecordingArchive}. */
export interface RecordingSink {
  /** Never throws and never blocks the caller: an upload is not the transcript. */
  archive(upload: RecordingUpload): void;
}

/**
 * Collects one session's utterance audio in object storage, and indexes it.
 *
 * The point is a second pass: each utterance is transcribed alone, so wording
 * drifts between them. Keeping the audio lets the whole meeting be handed to a
 * multimodal model afterwards, which sees every utterance in one context.
 *
 * Uploads are counted like utterances at the vendor, so `/transcriber stop`
 * can wait for them the same bounded way — an index naming objects that never
 * arrived would be worse than a short delay.
 */
export class RecordingArchive implements RecordingSink {
  private rows: ArchivedRecording[] = [];
  private pending = new PendingUtterances();
  private index = 0;

  constructor(
    private storage: ObjectStorage,
    private prefix: string,
    private guildId: string,
    private sessionId: string,
    private startedAt = new Date()
  ) {}

  get size(): number {
    return this.rows.length;
  }

  get inFlight(): number {
    return this.pending.size;
  }

  /**
   * The object key.
   *
   * Ordered by the utterance's position in the session rather than by message
   * id, so a plain listing of the bucket reads in the order people spoke. The
   * date is in the path so a lifecycle rule can expire whole days.
   */
  private keyFor(upload: RecordingUpload, ordinal: number): string {
    const day = this.startedAt.toISOString().slice(0, 10);
    const stamp = String(ordinal).padStart(5, "0");
    const suffix = upload.messageId ?? `t${upload.startedAt}`;
    const prefix = this.prefix ? `${this.prefix.replace(/\/+$/, "")}/` : "";
    return `${prefix}${day}/${this.guildId}/${this.sessionId}/${stamp}-${suffix}.wav`;
  }

  archive(upload: RecordingUpload): void {
    const key = this.keyFor(upload, this.index++);
    this.rows.push({
      messageId: upload.messageId,
      speakerId: upload.speakerId,
      startedAt: upload.startedAt,
      endedAt: upload.endedAt,
      seconds: upload.seconds,
      bytes: upload.wav.byteLength,
      key,
    });

    this.pending.started();
    void this.storage
      .put(key, upload.wav, "audio/wav")
      .catch((error) => {
        // Logged, not thrown, and the row stays. A missing object is visible
        // in the index as a link that 404s; losing the row would hide that an
        // utterance existed at all.
        logger.error(`Failed to archive recording ${key}:`, error);
      })
      .finally(() => this.pending.finished());
  }

  /** Waits for outstanding uploads. Resolves with however many did not land. */
  drain(timeoutMs: number): Promise<number> {
    return this.pending.drain(timeoutMs);
  }

  /**
   * The session's index: one row per recording, each with a link that expires.
   *
   * Signing needs no network and no object, so this is fast and works even for
   * an upload that is still in flight.
   */
  async toCsv(ttlSeconds: number): Promise<string> {
    const lines = [
      "started_at,ended_at,message_id,speaker_id,seconds,bytes,audio_url",
    ];
    for (const row of this.rows) {
      const url = await this.storage.presignGet(row.key, ttlSeconds);
      lines.push(
        [
          new Date(row.startedAt).toISOString(),
          new Date(row.endedAt).toISOString(),
          row.messageId ?? "",
          row.speakerId,
          row.seconds.toFixed(2),
          String(row.bytes),
          url,
        ]
          .map(csvField)
          .join(",")
      );
    }
    return lines.join("\r\n") + "\r\n";
  }
}
