/** One utterance, as it will appear in the session's CSV. */
export interface TranscriptEntry {
  /** Unix ms when the speaker started this utterance. */
  startedAt: number;
  /** Unix ms when the audio ended (not when the transcript came back). */
  endedAt: number;
  /** The bot's message for this utterance, or null if it never got one. */
  messageId: string | null;
  speakerId: string;
  /** Display name at the time, falling back to the id if it cannot be read. */
  speakerName: string;
  /** Empty when every attempt failed — the row still marks the gap. */
  text: string;
}

const HEADER = [
  "started_at",
  "ended_at",
  "message_id",
  "speaker_id",
  "speaker_name",
  "text",
] as const;

/**
 * Collects one `!transcribe` session's utterances and renders them as CSV.
 *
 * Pure and Discord-free, because the part most likely to be wrong is the
 * escaping: transcripts contain commas, quotation marks and line breaks, and
 * naive CSV writing corrupts the file at the first quote. Keeping it here means
 * it can be tested by writing a transcript and reading it back.
 */
export class SessionTranscript {
  private entries: TranscriptEntry[] = [];

  add(entry: TranscriptEntry): void {
    this.entries.push(entry);
  }

  get size(): number {
    return this.entries.length;
  }

  /**
   * Rows in the order people spoke.
   *
   * Not the order they completed: utterances finish out of order whenever two
   * people overlap, or when one needs a retry and its neighbour does not. A
   * transcript out of chronological order is hard to read and easy to
   * misattribute.
   */
  toCsv(): string {
    const rows = [...this.entries].sort((a, b) => a.startedAt - b.startedAt);
    const lines = [HEADER.join(",")];
    for (const entry of rows) {
      lines.push(
        [
          new Date(entry.startedAt).toISOString(),
          new Date(entry.endedAt).toISOString(),
          entry.messageId ?? "",
          entry.speakerId,
          entry.speakerName,
          entry.text,
        ]
          .map(csvField)
          .join(",")
      );
    }
    // Trailing newline: POSIX text, and some tools drop a last line without it.
    return lines.join("\r\n") + "\r\n";
  }
}

/**
 * RFC 4180: quote a field that contains a comma, a quote, CR or LF, and double
 * any quote inside it. Everything else is passed through unchanged.
 */
export function csvField(value: string): string {
  if (!/[",\r\n]/.test(value)) return value;
  return `"${value.replace(/"/g, '""')}"`;
}
