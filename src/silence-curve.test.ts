import assert from "node:assert/strict";
import { test } from "node:test";
import config from "./config.ts";
import { silenceNeededAfter } from "./user-audio-stream.ts";

const knobs = {
  silenceDuration: 1500,
  minSilenceDuration: 300,
  maxUtteranceMs: 120_000,
  easing: 1.25,
};

test("a fresh utterance gets the full silence duration", () => {
  assert.equal(silenceNeededAfter(0, knobs), 1500);
});

// The whole point: ordinary speech must segment exactly as it did before.
// A curve that hurried a 10 s utterance would chop up normal conversation.
test("ordinary utterances are barely hurried at all", () => {
  // 1500 ms nominal: ~1477 at 5 s, ~1446 at 10 s, ~1288 at 30 s.
  assert.ok(silenceNeededAfter(5_000, knobs) > 1470);
  assert.ok(silenceNeededAfter(10_000, knobs) > 1440);
  assert.ok(silenceNeededAfter(30_000, knobs) > 1250);
});

test("a long utterance ends on a pause far too short to have ended it before", () => {
  // At 110 s a ~425 ms breath is enough, where 1500 ms was needed at the start.
  const needed = silenceNeededAfter(110_000, knobs);
  assert.ok(needed < 500, `expected under 500ms, got ${needed}`);
  assert.ok(needed > knobs.minSilenceDuration);
});

test("the floor is reached at the cap and never passed", () => {
  assert.equal(silenceNeededAfter(120_000, knobs), 300);
  // Past the cap the value must not keep falling toward zero, which would end
  // an utterance on a single quiet frame.
  assert.equal(silenceNeededAfter(600_000, knobs), 300);
});

test("the curve never rises and stays inside its two bounds", () => {
  let previous = Infinity;
  for (let ms = 0; ms <= 130_000; ms += 500) {
    const needed = silenceNeededAfter(ms, knobs);
    assert.ok(needed <= previous + 1e-9, `rose at ${ms}ms`);
    assert.ok(needed <= knobs.silenceDuration, `above the ceiling at ${ms}ms`);
    assert.ok(needed >= knobs.minSilenceDuration, `below the floor at ${ms}ms`);
    previous = needed;
  }
});

// Easing above 1 is what protects normal speech: it keeps the curve flat early
// and puts the steep part near the cap.
test("easing above 1 is more patient early than a straight line", () => {
  const eased = silenceNeededAfter(30_000, knobs);
  const linear = silenceNeededAfter(30_000, { ...knobs, easing: 1 });
  assert.ok(eased > linear, `${eased} should exceed ${linear}`);
});

test("a nonsensical floor cannot make the segmenter more patient than the ceiling", () => {
  const needed = silenceNeededAfter(0, { ...knobs, minSilenceDuration: 9_000 });
  assert.equal(needed, 1500);
  const late = silenceNeededAfter(120_000, { ...knobs, minSilenceDuration: 9_000 });
  assert.equal(late, 1500);
});

test("a disabled cap degrades to the floor rather than dividing by zero", () => {
  const needed = silenceNeededAfter(10_000, { ...knobs, maxUtteranceMs: 0 });
  assert.equal(needed, 300);
  assert.ok(Number.isFinite(needed));
});

// The shipped defaults must satisfy the same invariants as the test knobs.
test("the configured defaults form a usable curve", () => {
  const live = {
    silenceDuration: config.SILENCE_DURATION,
    minSilenceDuration: config.MIN_SILENCE_DURATION,
    maxUtteranceMs: config.MAX_UTTERANCE_MS,
    easing: config.IMPATIENCE_EASING,
  };
  assert.ok(live.minSilenceDuration < live.silenceDuration);
  assert.ok(live.easing >= 1);
  assert.equal(silenceNeededAfter(0, live), live.silenceDuration);
  assert.equal(silenceNeededAfter(live.maxUtteranceMs, live), live.minSilenceDuration);
});
