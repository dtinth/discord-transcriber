import assert from "node:assert/strict";
import { test } from "node:test";
import { FakeTimers, drainMicrotasks } from "./fake-timers.ts";
import {
  DEBOUNCE_MS,
  THROTTLE_MS,
  ThrottledMessageUpdater,
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
  const channel = {
    send(content: string) {
      edits.push({ at: timers.now(), content });
      return Promise.resolve(message);
    },
  };
  return {
    channel: channel as any,
    edits,
    get deleted() {
      return deleted;
    },
  };
}

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
