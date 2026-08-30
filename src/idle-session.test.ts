import assert from "node:assert/strict";
import { test } from "node:test";
import type { AsrSetup } from "./asr-setup.ts";
import { TranscriptionService } from "./transcription-service.ts";

const asr = { configurations: [], env: {} } as unknown as AsrSetup;

/**
 * The service needs only `receiver` and `joinConfig.guildId` from a voice
 * connection. `subscribe` throws on purpose: the activity clock is touched
 * before any audio stream is built, so the throw isolates what is measured
 * here from the VAD, the decoder and the vendor.
 */
function fakeConnection(guildId = "g1") {
  let onSpeakingStart: ((userId: string) => void) | undefined;
  const connection = {
    joinConfig: { guildId },
    receiver: {
      speaking: {
        on: (_event: string, handler: (userId: string) => void) => {
          onSpeakingStart = handler;
        },
      },
      subscribe: () => {
        throw new Error("no audio in this test");
      },
    },
  };
  return {
    connection: connection as never,
    speak: (userId = "u1") => onSpeakingStart?.(userId),
  };
}

const channel = { id: "c1" } as never;

test("a new session starts with no idle time", () => {
  const service = new TranscriptionService(asr);
  const fake = fakeConnection();
  const id = service.createTranscriptionStream(fake.connection, channel);

  assert.ok(service.idleMs(id) < 1000);
});

test("idle time grows while nobody speaks", () => {
  const service = new TranscriptionService(asr);
  const fake = fakeConnection();
  const id = service.createTranscriptionStream(fake.connection, channel);

  const later = Date.now() + 1_900_000; // past the 1800 s default
  assert.ok(service.idleMs(id, later) > 1_800_000);
});

// The whole mechanism: speech, and only speech, keeps a session alive.
test("speaking resets the idle clock", () => {
  const service = new TranscriptionService(asr);
  const fake = fakeConnection();
  const id = service.createTranscriptionStream(fake.connection, channel);

  const later = Date.now() + 1_900_000;
  assert.ok(service.idleMs(id, later) > 1_800_000);

  fake.speak();
  assert.ok(
    service.idleMs(id) < 1000,
    "a speaking start must count as activity"
  );
});

// The audio stream fails to build here, which is the point: the session is
// still receiving voice even when the bot cannot do anything with it, and
// leaving the channel out from under people who are talking would be worse.
test("activity is recorded even when the audio stream cannot start", () => {
  const service = new TranscriptionService(asr);
  const fake = fakeConnection();
  const id = service.createTranscriptionStream(fake.connection, channel);
  const later = Date.now() + 1_900_000;
  assert.ok(service.idleMs(id, later) > 1_800_000);

  assert.doesNotThrow(() => fake.speak());
  assert.ok(service.idleMs(id) < 1000);
});

test("a stopped session can never trigger the sweep again", () => {
  const service = new TranscriptionService(asr);
  const fake = fakeConnection();
  const id = service.createTranscriptionStream(fake.connection, channel);

  service.stopTranscription(id);
  const later = Date.now() + 9_000_000;
  assert.equal(
    service.idleMs(id, later),
    0,
    "an id the service has forgotten must read as active, not as idle for ever"
  );
});

test("sessions keep their own clocks", () => {
  const service = new TranscriptionService(asr);
  const first = fakeConnection("g1");
  const second = fakeConnection("g2");
  const a = service.createTranscriptionStream(first.connection, channel);
  const b = service.createTranscriptionStream(second.connection, channel);

  const later = Date.now() + 1_900_000;
  first.speak();
  assert.ok(service.idleMs(a) < 1000, "the guild that spoke stays active");
  assert.ok(service.idleMs(b, later) > 1_800_000, "the quiet guild goes idle");
});

test("stats report the idle time the sweep acts on", () => {
  const service = new TranscriptionService(asr);
  const fake = fakeConnection();
  const id = service.createTranscriptionStream(fake.connection, channel);

  const stats = service.sessionStats(id);
  assert.equal(stats.speakers, 0);
  assert.equal(stats.pendingUtterances, 0);
  assert.ok(stats.idleSeconds >= 0 && stats.idleSeconds < 2);
});
