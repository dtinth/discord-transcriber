import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { test } from "node:test";
import { FakeTimers, drainMicrotasks } from "./fake-timers.ts";
import { FRAME_BYTES, FRAME_INTERVAL_MS, feedRecording } from "./paced-feeder.ts";
import { Recording } from "./recording.ts";

function fakeSession() {
  const sends: Array<{ at: number; bytes: number }> = [];
  let finishedAt: number | null = null;
  return {
    sends,
    get finishedAt() {
      return finishedAt;
    },
    session: (timers: FakeTimers) => ({
      sendAudio(chunk: Buffer) {
        sends.push({ at: timers.now(), bytes: chunk.length });
      },
      finish() {
        finishedAt = timers.now();
      },
    }),
  };
}

test("realtime replay paces a backlog at one frame per interval", async () => {
  const timers = new FakeTimers();
  const recording = new Recording();
  recording.append(Buffer.alloc(FRAME_BYTES * 3));
  recording.end();

  const fake = fakeSession();
  const done = feedRecording({
    recording,
    session: fake.session(timers),
    fastDump: false,
    signal: new AbortController().signal,
    timers,
  });

  await timers.runUntil(done);

  assert.deepEqual(
    fake.sends.map((send) => send.at),
    [0, FRAME_INTERVAL_MS, FRAME_INTERVAL_MS * 2]
  );
  assert.equal(fake.finishedAt, FRAME_INTERVAL_MS * 2);
});

test("fast dump sends the whole backlog without waiting", async () => {
  const timers = new FakeTimers();
  const recording = new Recording();
  recording.append(Buffer.alloc(FRAME_BYTES * 5));
  recording.end();

  const fake = fakeSession();
  await timers.runUntil(
    feedRecording({
      recording,
      session: fake.session(timers),
      fastDump: true,
      signal: new AbortController().signal,
      timers,
    })
  );

  assert.equal(fake.sends.length, 5);
  assert.ok(fake.sends.every((send) => send.at === 0));
  assert.equal(fake.finishedAt, 0);
});

test("live audio is forwarded as it arrives and finish follows end", async () => {
  const timers = new FakeTimers();
  const recording = new Recording();
  const fake = fakeSession();

  const done = feedRecording({
    recording,
    session: fake.session(timers),
    fastDump: false,
    signal: new AbortController().signal,
    timers,
  });

  await drainMicrotasks();
  assert.equal(fake.sends.length, 0); // waiting for audio, not spinning

  recording.append(Buffer.alloc(640)); // a 20 ms Discord-sized chunk
  await drainMicrotasks();
  assert.equal(fake.sends.length, 1);
  assert.equal(fake.finishedAt, null);

  recording.append(Buffer.alloc(640));
  recording.end();
  await timers.runUntil(done);

  assert.equal(fake.sends.length, 2);
  assert.equal(fake.finishedAt, 0); // no pacing sleeps happened at the tail
});

test("abort stops the feeder without calling finish", async () => {
  const timers = new FakeTimers();
  const recording = new Recording();
  recording.append(Buffer.alloc(FRAME_BYTES * 10));
  recording.end();

  const abort = new AbortController();
  const fake = fakeSession();
  const done = feedRecording({
    recording,
    session: fake.session(timers),
    fastDump: false,
    signal: abort.signal,
    timers,
  });

  await drainMicrotasks(); // first frame sent, now sleeping
  abort.abort();
  await timers.runUntil(done);

  assert.equal(fake.sends.length, 1);
  assert.equal(fake.finishedAt, null);
});
