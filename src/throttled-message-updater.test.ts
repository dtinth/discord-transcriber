import assert from "node:assert/strict";
import { test } from "node:test";
import { MessageFlags } from "discord.js";
import { FakeTimers, drainMicrotasks } from "./fake-timers.ts";
import {
  DEBOUNCE_MS,
  DISCORD_MAX_CONTENT,
  THROTTLE_MS,
  ThrottledMessageUpdater,
  splitForDiscord,
} from "./throttled-message-updater.ts";

function fakeChannel(timers: FakeTimers) {
  const edits: Array<{ at: number; content: string }> = [];
  let deleted = false;
  const message = {
    edit(payload: string | { content: string }) {
      const content = typeof payload === "string" ? payload : payload.content;
      edits.push({ at: timers.now(), content });
      return Promise.resolve(message);
    },
    delete() {
      deleted = true;
      return Promise.resolve(message);
    },
  };
  const sendFlags: unknown[] = [];
  const sent: string[] = [];
  let placeholderSent = false;
  const channel = {
    send(payload: string | { content: string; flags?: unknown }) {
      const content = typeof payload === "string" ? payload : payload.content;
      if (typeof payload !== "string") sendFlags.push(payload.flags);
      if (placeholderSent) sent.push(content);
      placeholderSent = true;
      edits.push({ at: timers.now(), content });
      return Promise.resolve(message);
    },
  };
  return {
    channel: channel as any,
    edits,
    sendFlags,
    sent,
    get deleted() {
      return deleted;
    },
  };
}

test("the placeholder is sent silent (no channel-wide notification)", async () => {
  const timers = new FakeTimers();
  const fake = fakeChannel(timers);
  new ThrottledMessageUpdater("u", fake.channel, timers);
  await drainMicrotasks();

  assert.deepEqual(fake.sendFlags, [MessageFlags.SuppressNotifications]);
});

test("a rapid-fire burst collapses into one edit after the debounce", async () => {
  const timers = new FakeTimers();
  const fake = fakeChannel(timers);
  const updater = new ThrottledMessageUpdater("u", fake.channel, timers);
  await drainMicrotasks();

  // Qwen-Omni style: everything arrives within a few ms.
  updater.setPartial("a");
  updater.setPartial("ab");
  updater.setPartial("abc");
  await timers.advance(DEBOUNCE_MS + 10);

  const partials = fake.edits.slice(1); // [0] is the placeholder
  assert.equal(partials.length, 1);
  assert.equal(partials[0].content, "<@u>: abc …");
  assert.equal(partials[0].at, DEBOUNCE_MS);
});

test("a continuous stream is throttled to one edit per THROTTLE_MS", async () => {
  const timers = new FakeTimers();
  const fake = fakeChannel(timers);
  const updater = new ThrottledMessageUpdater("u", fake.channel, timers);
  await drainMicrotasks();

  // Qwen style: a partial every 100 ms for 4.5 s.
  for (let i = 1; i <= 45; i++) {
    updater.setPartial(`text ${i}`);
    await timers.advance(100);
  }

  const partials = fake.edits.slice(1);
  assert.deepEqual(
    partials.map((edit) => edit.at),
    [THROTTLE_MS, THROTTLE_MS * 2, THROTTLE_MS * 3]
  );
  // Each edit carries the latest text at its moment.
  assert.equal(partials[0].content, "<@u>: text 15 …");
});

test("finalize bypasses debounce and throttle and suppresses stale partials", async () => {
  const timers = new FakeTimers();
  const fake = fakeChannel(timers);
  const updater = new ThrottledMessageUpdater("u", fake.channel, timers);
  await drainMicrotasks();

  updater.setPartial("stale");
  const done = updater.finalize("the final text");
  await timers.advance(THROTTLE_MS * 2);
  await done;

  const afterPlaceholder = fake.edits.slice(1);
  assert.deepEqual(
    afterPlaceholder.map((edit) => edit.content),
    ["<@u>: the final text"]
  );
  assert.equal(afterPlaceholder[0].at, 0);
});

test("noSpeech deletes the message and later calls are inert", async () => {
  const timers = new FakeTimers();
  const fake = fakeChannel(timers);
  const updater = new ThrottledMessageUpdater("u", fake.channel, timers);
  await drainMicrotasks();

  await updater.noSpeech();
  assert.equal(fake.deleted, true);

  updater.setPartial("too late");
  await timers.advance(THROTTLE_MS * 2);
  assert.equal(fake.edits.length, 1); // placeholder only
});

test("status updates show only before any partial text", async () => {
  const timers = new FakeTimers();
  const fake = fakeChannel(timers);
  const updater = new ThrottledMessageUpdater("u", fake.channel, timers);
  await drainMicrotasks();

  updater.setStatus("Transcribing...");
  await drainMicrotasks();
  assert.equal(fake.edits.at(-1)?.content, "<@u>: *Transcribing...*");

  updater.setPartial("words");
  updater.setStatus("Retrying (attempt 2)..."); // ignored: text is pending
  await timers.advance(THROTTLE_MS);
  assert.equal(fake.edits.at(-1)?.content, "<@u>: words …");
});

// A 196 s utterance produced a transcript past Discord's limit in production.
// The edit failed with "Invalid Form Body" and the transcript was lost, leaving
// the message stuck on "Transcribing…".
test("splitForDiscord never drops content and prefers word boundaries", () => {
  const words = Array.from({ length: 400 }, (_, i) => `word${i}`).join(" ");
  const parts = splitForDiscord(words, 100);

  assert.ok(parts.length > 1);
  assert.ok(parts.every((part) => part.length <= 100));
  assert.equal(parts.join(" "), words, "no content may be lost in the split");
  assert.ok(
    parts.every((part) => !part.startsWith(" ") && !part.endsWith(" ")),
    "parts should be trimmed at their boundaries"
  );
});

test("splitForDiscord still splits text with no spaces at all", () => {
  const solid = "x".repeat(250);
  const parts = splitForDiscord(solid, 100);
  assert.deepEqual(parts.map((p) => p.length), [100, 100, 50]);
  assert.equal(parts.join(""), solid);
});

test("a transcript longer than Discord allows arrives as several messages", async () => {
  const timers = new FakeTimers();
  const fake = fakeChannel(timers);
  const updater = new ThrottledMessageUpdater("u", fake.channel, timers);
  await drainMicrotasks();

  const long = Array.from({ length: 900 }, (_, i) => `word${i}`).join(" ");
  await updater.finalize(long);
  await drainMicrotasks();

  const delivered = [fake.edits[1], ...fake.sent.map((content) => ({ content }))]
    .map((entry) => entry.content.replace(/^<@u>: /, ""))
    .join(" ");
  assert.equal(delivered, long, "the whole transcript must reach the channel");
  assert.ok(
    fake.edits.every((entry) => entry.content.length <= DISCORD_MAX_CONTENT),
    "no message may exceed Discord's limit"
  );
  assert.ok(fake.sent.length >= 1, "the remainder should be sent as follow-ups");
});

test("an over-long partial is trimmed rather than failing the edit", async () => {
  const timers = new FakeTimers();
  const fake = fakeChannel(timers);
  const updater = new ThrottledMessageUpdater("u", fake.channel, timers);
  await drainMicrotasks();

  updater.setPartial("y".repeat(5000));
  await timers.advance(THROTTLE_MS);

  const partial = fake.edits.at(-1)!;
  assert.ok(partial.content.length <= DISCORD_MAX_CONTENT);
  assert.ok(partial.content.includes("…"), "trimming should be visible");
});
