import assert from "node:assert/strict";
import { test } from "node:test";
import { PendingUtterances } from "./pending-utterances.ts";

test("counts what is outstanding", () => {
  const p = new PendingUtterances();
  assert.equal(p.size, 0);
  p.started();
  p.started();
  assert.equal(p.size, 2);
  p.finished();
  assert.equal(p.size, 1);
});

// A silent utterance reports a finish and no row; a double report must not
// cancel a different utterance that is genuinely still running.
test("a double finish cannot drive the count negative", () => {
  const p = new PendingUtterances();
  p.started();
  p.finished();
  p.finished();
  assert.equal(p.size, 0);

  p.started();
  assert.equal(p.size, 1, "a later utterance is still counted");
});

test("drain returns immediately when nothing is outstanding", async () => {
  const p = new PendingUtterances();
  let slept = 0;
  const left = await p.drain(20_000, { sleep: async (ms) => { slept += ms; } });
  assert.equal(left, 0);
  assert.equal(slept, 0, "must not wait when there is nothing to wait for");
});

test("drain waits for an utterance that lands while waiting", async () => {
  const p = new PendingUtterances();
  p.started();
  let ticks = 0;
  const left = await p.drain(20_000, {
    pollMs: 10,
    sleep: async () => {
      // Lands on the third poll.
      if (++ticks === 3) p.finished();
    },
  });
  assert.equal(left, 0);
  assert.equal(ticks, 3);
});

// A stalled vendor must delay the file, not prevent it.
test("drain gives up at the deadline and reports what is missing", async () => {
  const p = new PendingUtterances();
  p.started();
  p.started();

  let clock = 0;
  const left = await p.drain(1000, {
    pollMs: 250,
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
  });

  assert.equal(left, 2, "reports the utterances that never landed");
  assert.ok(clock >= 1000, "waited the full timeout before giving up");
});
