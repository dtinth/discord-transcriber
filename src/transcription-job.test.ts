import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { test } from "node:test";
import type { ASRProvider, ASRSessionCallbacks, ConfigurationDefinition } from "vxasr";
import { FakeTimers } from "./fake-timers.ts";
import { Recording } from "./recording.ts";
import { FINISH_TIMEOUT_MS, runTranscriptionJob } from "./transcription-job.ts";

type SessionScript = (callbacks: ASRSessionCallbacks, log: string[]) => {
  onFinish?: () => void;
};

/** A provider whose sessions follow a script; records lifecycle in `log`. */
function scriptedProvider(log: string[], name: string, script: SessionScript): ASRProvider {
  return {
    createSession(callbacks) {
      log.push(`${name}:create`);
      const hooks = script(callbacks, log);
      return {
        sendAudio() {},
        finish() {
          log.push(`${name}:finish`);
          hooks.onFinish?.();
        },
        close() {
          log.push(`${name}:close`);
        },
      };
    },
  };
}

/** Wrap a provider as a resolvable ConfigurationDefinition (providerId "mock" → fast dump). */
function definition(id: string, provider: ASRProvider): ConfigurationDefinition {
  return {
    id,
    label: id,
    providerId: "mock",
    model: "mock",
    postProcessing: [],
    isConfigured: () => true,
    missingConfig: () => [],
    resolve: () => ({ ok: true, provider, configurationId: id }),
  };
}

function endedRecording(): Recording {
  const recording = new Recording();
  recording.append(Buffer.alloc(6400));
  recording.end();
  return recording;
}

test("a healthy session resolves with transcript and usage", async () => {
  const timers = new FakeTimers();
  const log: string[] = [];
  const provider = scriptedProvider(log, "a", (callbacks) => ({
    onFinish() {
      callbacks.onPartial?.("hel");
      callbacks.onFinal?.("hello");
      callbacks.onUsage?.([{ sku: "s", unitPrice: 2, quantity: 3 }]);
      callbacks.onEnd?.();
    },
  }));

  const partials: string[] = [];
  const result = await timers.runUntil(
    runTranscriptionJob({
      recording: endedRecording(),
      configurations: [definition("a/mock", provider)],
      env: {},
      onPartial: (text) => partials.push(text),
      timers,
    })
  );

  assert.equal(result.text, "hello");
  assert.equal(result.attempt, 1);
  assert.deepEqual(partials, ["hel"]);
  assert.deepEqual(result.usage, [{ sku: "s", unitPrice: 2, quantity: 3 }]);
  assert.deepEqual(log, ["a:create", "a:finish", "a:close"]);
});

test("retry rotates through the configuration list with backoff", async () => {
  const timers = new FakeTimers();
  const log: string[] = [];
  const failing = scriptedProvider(log, "bad", (callbacks) => {
    queueMicrotask(() => callbacks.onError?.(new Error("boom")));
    return {};
  });
  const succeeding = scriptedProvider(log, "good", (callbacks) => ({
    onFinish: () => {
      callbacks.onFinal?.("saved");
      callbacks.onEnd?.();
    },
  }));

  const attempts: Array<[number, string]> = [];
  const start = timers.now();
  const result = await timers.runUntil(
    runTranscriptionJob({
      recording: endedRecording(),
      configurations: [
        definition("bad/mock", failing),
        definition("good/mock", succeeding),
      ],
      env: {},
      onAttemptStart: (attempt, id) => attempts.push([attempt, id]),
      timers,
    })
  );

  assert.equal(result.text, "saved");
  assert.equal(result.attempt, 2);
  assert.equal(result.configurationId, "good/mock");
  assert.deepEqual(attempts, [
    [1, "bad/mock"],
    [2, "good/mock"],
  ]);
  // 1s backoff before attempt 2.
  assert.equal(timers.now() - start, 1000);
  // Both sessions were closed.
  assert.deepEqual(
    log.filter((entry) => entry.endsWith(":close")),
    ["bad:close", "good:close"]
  );
});

test("gives up after maxAttempts and throws the last error", async () => {
  const timers = new FakeTimers();
  const log: string[] = [];
  const failing = scriptedProvider(log, "bad", (callbacks) => {
    queueMicrotask(() => callbacks.onError?.(new Error("always down")));
    return {};
  });

  const start = timers.now();
  await assert.rejects(
    timers.runUntil(
      runTranscriptionJob({
        recording: endedRecording(),
        configurations: [definition("bad/mock", failing)],
        env: {},
        timers,
      })
    ),
    /always down/
  );

  assert.equal(log.filter((entry) => entry === "bad:create").length, 5);
  assert.equal(log.filter((entry) => entry === "bad:close").length, 5);
  // Backoffs: 1s + 2s + 4s + 8s.
  assert.equal(timers.now() - start, 15000);
});

test("watchdog salvages a final transcript from a vendor that never ends", async () => {
  const timers = new FakeTimers();
  const log: string[] = [];
  const silent = scriptedProvider(log, "s", (callbacks) => ({
    onFinish: () => {
      callbacks.onFinal?.("rescued");
      // No onEnd, ever.
    },
  }));

  const result = await timers.runUntil(
    runTranscriptionJob({
      recording: endedRecording(),
      configurations: [definition("s/mock", silent)],
      env: {},
      timers,
    })
  );

  assert.equal(result.text, "rescued");
  assert.equal(timers.now(), FINISH_TIMEOUT_MS);
});

test("watchdog fails a vendor that goes fully silent after finish", async () => {
  const timers = new FakeTimers();
  const log: string[] = [];
  const dead = scriptedProvider(log, "d", () => ({}));

  await assert.rejects(
    timers.runUntil(
      runTranscriptionJob({
        recording: endedRecording(),
        configurations: [definition("d/mock", dead)],
        env: {},
        maxAttempts: 1,
        timers,
      })
    ),
    /no result within/
  );
  assert.deepEqual(log, ["d:create", "d:finish", "d:close"]);
});
