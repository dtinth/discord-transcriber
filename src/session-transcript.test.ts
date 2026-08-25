import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionTranscript, csvField, type TranscriptEntry } from "./session-transcript.ts";

function entry(overrides: Partial<TranscriptEntry> = {}): TranscriptEntry {
  return {
    startedAt: Date.parse("2026-08-25T10:00:00Z"),
    endedAt: Date.parse("2026-08-25T10:00:05Z"),
    messageId: "111",
    speakerId: "s1",
    speakerName: "Alice",
    text: "hello",
    ...overrides,
  };
}

/**
 * A minimal RFC 4180 reader, so the tests verify the file by *reading it back*
 * rather than by matching the string we just produced. Asserting on the output
 * shape would pass even if the escaping were wrong in a way a spreadsheet
 * would choke on.
 */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        quoted = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"') { quoted = true; i++; continue; }
    if (c === ",") { row.push(field); field = ""; i++; continue; }
    if (c === "\r" && text[i + 1] === "\n") {
      row.push(field); rows.push(row); row = []; field = ""; i += 2; continue;
    }
    field += c; i++;
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

test("writes the requested columns in order", () => {
  const t = new SessionTranscript();
  t.add(entry());
  const rows = parseCsv(t.toCsv());

  assert.deepEqual(rows[0], [
    "started_at", "ended_at", "message_id", "speaker_id", "speaker_name", "text",
  ]);
  assert.deepEqual(rows[1], [
    "2026-08-25T10:00:00.000Z",
    "2026-08-25T10:00:05.000Z",
    "111",
    "s1",
    "Alice",
    "hello",
  ]);
});

// The failure that corrupts the whole file rather than one cell.
test("text with commas, quotes and newlines survives a round trip", () => {
  const nasty = 'She said "yes, absolutely" — then,\nafter a pause,\r\n"maybe".';
  const t = new SessionTranscript();
  t.add(entry({ text: nasty, speakerName: 'Bob "The Comma" O,Brien' }));

  const rows = parseCsv(t.toCsv());
  assert.equal(rows.length, 2, "the embedded newlines must not create extra rows");
  assert.equal(rows[1][5], nasty);
  assert.equal(rows[1][4], 'Bob "The Comma" O,Brien');
});

test("rows are ordered by when people spoke, not by when transcripts arrived", () => {
  const t = new SessionTranscript();
  // Added out of order, as concurrent speakers and retries produce them.
  t.add(entry({ startedAt: Date.parse("2026-08-25T10:00:30Z"), text: "third" }));
  t.add(entry({ startedAt: Date.parse("2026-08-25T10:00:10Z"), text: "first" }));
  t.add(entry({ startedAt: Date.parse("2026-08-25T10:00:20Z"), text: "second" }));

  const rows = parseCsv(t.toCsv()).slice(1);
  assert.deepEqual(rows.map((r) => r[5]), ["first", "second", "third"]);
});

// A file that silently omits failures reads as a complete record and is not one.
test("an utterance that never transcribed still leaves a row", () => {
  const t = new SessionTranscript();
  t.add(entry({ text: "", messageId: null, speakerName: "Carol" }));

  const rows = parseCsv(t.toCsv());
  assert.equal(rows[1][2], "", "no message id");
  assert.equal(rows[1][5], "", "no text");
  assert.equal(rows[1][4], "Carol", "but the speaker and time are kept");
});

test("an empty session still produces a header", () => {
  const rows = parseCsv(new SessionTranscript().toCsv());
  assert.equal(rows.length, 1);
  assert.equal(rows[0][0], "started_at");
});

test("csvField quotes only what needs quoting", () => {
  assert.equal(csvField("plain"), "plain");
  assert.equal(csvField("a,b"), '"a,b"');
  assert.equal(csvField('say "hi"'), '"say ""hi"""');
  assert.equal(csvField("line\nbreak"), '"line\nbreak"');
});
