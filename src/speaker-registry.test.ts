import assert from "node:assert/strict";
import { test } from "node:test";
import { SpeakerRegistry, type SpeakerStream } from "./speaker-registry.ts";

const noop: SpeakerStream = { destroy: () => {} };

test("opens one stream per speaker while that stream is live", () => {
  const registry = new SpeakerRegistry();
  const started: string[] = [];
  const open = (userId: string) =>
    registry.start(userId, () => {
      started.push(userId);
      return noop;
    });

  assert.equal(open("u1"), true);
  assert.equal(open("u1"), false); // already live
  assert.equal(open("u2"), true);
  assert.deepEqual(started, ["u1", "u2"]);
  assert.equal(registry.size, 2);
});

test("picks a speaker up again after their stream ends", () => {
  const registry = new SpeakerRegistry();
  let release!: () => void;

  assert.equal(
    registry.start("u1", (onEnd) => {
      release = onEnd;
      return noop;
    }),
    true
  );
  assert.equal(registry.has("u1"), true);

  release();
  assert.equal(registry.has("u1"), false);
  assert.equal(registry.start("u1", () => noop), true);
});

// The regression that made the bot go deaf: a decoder that threw during setup
// left the speaker marked active with no stream to ever release them, so every
// later utterance from that person was silently dropped.
test("a failed setup releases the speaker instead of wedging them", () => {
  const registry = new SpeakerRegistry();

  assert.throws(
    () =>
      registry.start("u1", () => {
        throw new Error("decoder is dead");
      }),
    /decoder is dead/
  );

  assert.equal(registry.has("u1"), false);
  assert.equal(registry.size, 0);
  // The speaker can still be heard once the cause is gone.
  assert.equal(registry.start("u1", () => noop), true);
});

test("a repeated release does not free a newer stream's slot", () => {
  const registry = new SpeakerRegistry();
  let releaseFirst!: () => void;
  registry.start("u1", (onEnd) => {
    releaseFirst = onEnd;
    return noop;
  });

  releaseFirst();
  const second: SpeakerStream = { destroy: () => {} };
  registry.start("u1", () => second);

  // The dead stream's teardown runs again (error path plus end path).
  releaseFirst();

  assert.equal(registry.has("u1"), true, "the newer stream must stay live");
});

test("a stream that ends during setup is not recorded as live", () => {
  const registry = new SpeakerRegistry();
  assert.equal(
    registry.start("u1", (onEnd) => {
      onEnd(); // e.g. the source was already gone
      return noop;
    }),
    true
  );
  assert.equal(registry.has("u1"), false);
});

test("destroyAll tears down every live stream and survives a thrower", () => {
  const registry = new SpeakerRegistry();
  const destroyed: string[] = [];
  registry.start("u1", () => ({ destroy: () => destroyed.push("u1") }));
  registry.start("u2", () => ({
    destroy: () => {
      throw new Error("teardown failed");
    },
  }));
  registry.start("u3", () => ({ destroy: () => destroyed.push("u3") }));

  const errors: unknown[] = [];
  registry.destroyAll((error) => errors.push(error));

  assert.deepEqual(destroyed, ["u1", "u3"]);
  assert.equal(errors.length, 1);
  assert.equal(registry.size, 0);
});
