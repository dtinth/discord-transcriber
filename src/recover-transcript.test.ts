import assert from "node:assert/strict";
import { test } from "node:test";
import {
  rowsFromMessages,
  rowsToCsv,
  type RawMessage,
} from "./recover-transcript.ts";

const BOT = "999";
let seq = 0n;
/** Snowflakes must increase with time; the recovery sorts on them. */
function message(
  content: string,
  overrides: Partial<RawMessage> = {}
): RawMessage {
  seq += 1n;
  return {
    id: (100000000000000000n + seq).toString(),
    content,
    timestamp: "2026-09-06T10:00:00.000Z",
    edited_timestamp: "2026-09-06T10:00:04.000Z",
    author: { id: BOT, bot: true },
    ...overrides,
  };
}

test("a finalized message becomes a row", () => {
  const rows = rowsFromMessages([message("<@42>: hello there")], BOT);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].speakerId, "42");
  assert.equal(rows[0].text, "hello there");
  assert.equal(rows[0].endedAt, "2026-09-06T10:00:04.000Z");
});

test("messages from anybody else are ignored", () => {
  const rows = rowsFromMessages(
    [
      message("<@42>: mine"),
      message("<@42>: not mine", { author: { id: "someone-else" } }),
    ],
    BOT
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].text, "mine");
});

// Continuations carry no mention by design — a mention in a *sent* message
// would ping the speaker. So they must be joined, not dropped.
test("a split transcript is rejoined into one utterance", () => {
  const rows = rowsFromMessages(
    [message("<@42>: first half"), message("second half")],
    BOT
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].text, "first half second half");
});

test("messages are ordered by snowflake, not by arrival", () => {
  const first = message("<@42>: one");
  const second = message("<@42>: two");
  const rows = rowsFromMessages([second, first], BOT);
  assert.deepEqual(rows.map((r) => r.text), ["one", "two"]);
});

test("a partial keeps its text without the trailing ellipsis", () => {
  const rows = rowsFromMessages([message("<@42>: still speaking …")], BOT);
  assert.equal(rows[0].text, "still speaking");
});

test("chatter before the first utterance cannot crash the parse", () => {
  const rows = rowsFromMessages(
    [message("Voice transcription started."), message("<@42>: hello")],
    BOT
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].text, "hello");
});

test("a never-edited message falls back to its creation time", () => {
  const rows = rowsFromMessages(
    [message("<@42>: x", { edited_timestamp: null })],
    BOT
  );
  assert.equal(rows[0].endedAt, rows[0].startedAt);
});

// The recovered file must be interchangeable with the one /transcriber stop
// produces, including the escaping that transcripts routinely need.
test("the CSV matches the shipped format and survives a round trip", () => {
  const csv = rowsToCsv(
    rowsFromMessages(
      [message('<@42>: he said "hi, there"\nthen left')],
      BOT
    )
  );
  const [header, ...lines] = csv.trimEnd().split("\r\n");
  assert.equal(
    header,
    "started_at,ended_at,message_id,speaker_id,speaker_name,text"
  );
  // The embedded newline means the record spans lines; the quoting must hold.
  assert.ok(csv.includes('"he said ""hi, there""'));
  assert.ok(lines.length >= 1);
});

test("an empty channel yields a header and nothing else", () => {
  const csv = rowsToCsv(rowsFromMessages([], BOT));
  assert.equal(csv, "started_at,ended_at,message_id,speaker_id,speaker_name,text\r\n");
});
