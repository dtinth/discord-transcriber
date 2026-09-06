import { csvField } from "./session-transcript.ts";

/**
 * Rebuilds a session transcript from the messages the bot already posted.
 *
 * The CSV is normally assembled in memory and uploaded by `/transcriber stop`.
 * If a session's bookkeeping is lost, that file goes with it — but the
 * transcripts themselves are still in the channel, one message per utterance,
 * and **the bot wrote them**. Discord always returns the content of messages
 * an application authored, whatever intents it holds, so this needs no
 * privileged intent and no access to the running process.
 *
 * What is recoverable and what is not:
 * - `text`, `speaker_id`, `message_id` come back exactly.
 * - `started_at` is the message's creation time, which is when the utterance
 *   began: the placeholder is posted the moment speech is detected.
 * - `ended_at` is the last edit, which is when the final transcript landed.
 *   For a message never edited (there should be none) it falls back to
 *   creation.
 * - `speaker_name` is not in the message — only the id is — so it is left
 *   empty unless a lookup is supplied.
 * - Utterances that produced no speech were deleted, and stay lost. So do any
 *   whose message was deleted by hand.
 */

/** The subset of Discord's message payload this needs. */
export interface RawMessage {
  id: string;
  content: string;
  timestamp: string;
  edited_timestamp?: string | null;
  author: { id: string; bot?: boolean };
}

export interface RecoveredRow {
  startedAt: string;
  endedAt: string;
  messageId: string;
  speakerId: string;
  speakerName: string;
  text: string;
}

/** A finalized transcript message: `<@123>: what they said`. */
const SPOKEN = /^<@!?(\d+)>:\s*([\s\S]*)$/;

/**
 * Turn raw messages into transcript rows.
 *
 * `messages` may be in any order; they are sorted by id, which is a snowflake
 * and therefore chronological. Continuation messages — the remainder of a
 * transcript too long for one message — carry no mention by design, so they
 * are appended to the utterance they continue rather than dropped.
 */
export function rowsFromMessages(
  messages: RawMessage[],
  botId: string,
  speakerName: (speakerId: string) => string = () => ""
): RecoveredRow[] {
  const ordered = [...messages]
    .filter((message) => message.author.id === botId)
    .sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));

  const rows: RecoveredRow[] = [];
  for (const message of ordered) {
    const match = SPOKEN.exec(message.content);
    if (!match) {
      // A continuation of the message before it. Anything else the bot said —
      // a budget notice, "Voice transcription started" — has no previous row
      // to attach to only at the very start, and is skipped there.
      const previous = rows[rows.length - 1];
      if (previous && message.content.trim()) {
        previous.text += " " + message.content.trim();
        previous.endedAt = message.edited_timestamp ?? message.timestamp;
      }
      continue;
    }

    const text = match[2].trim();
    // Still in progress when the session was lost: the trailing ellipsis marks
    // a partial. Kept — a partial transcript beats an empty row.
    const cleaned = text.endsWith("…") ? text.slice(0, -1).trim() : text;
    rows.push({
      startedAt: message.timestamp,
      endedAt: message.edited_timestamp ?? message.timestamp,
      messageId: message.id,
      speakerId: match[1],
      speakerName: speakerName(match[1]),
      text: cleaned,
    });
  }
  return rows;
}

/** The same columns, order and escaping `/transcriber stop` produces. */
export function rowsToCsv(rows: RecoveredRow[]): string {
  const lines = [
    "started_at,ended_at,message_id,speaker_id,speaker_name,text",
    ...rows.map((row) =>
      [
        new Date(row.startedAt).toISOString(),
        new Date(row.endedAt).toISOString(),
        row.messageId,
        row.speakerId,
        row.speakerName,
        row.text,
      ]
        .map(csvField)
        .join(",")
    ),
  ];
  return lines.join("\r\n") + "\r\n";
}
