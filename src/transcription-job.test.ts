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

/** Wrap a provider as a resolvable ConfigurationDefinition (fast-dump, like the mock provider). */
function definition(id: string, provider: ASRProvider): ConfigurationDefinition {
  return {
    id,
    label: id,
    providerId: "mock",
    model: "mock",
    postProcessing: [],
    supportsFastDump: true,
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
  // Deliberately no "a:close": a session that ended on its own is left for the
  // provider to dispose of, so qwen-omni can offer the connection to its reuse
  // pool. Closing here would terminate it first and disable reuse silently.
  assert.deepEqual(log, ["a:create", "a:finish"]);
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
  // The failed session is closed — nothing else would release its socket. The
  // one that ended cleanly is left to the provider (see the note above).
  assert.deepEqual(
    log.filter((entry) => entry.endsWith(":close")),
    ["bad:close"]
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
  // The watchdog fired rather than the vendor ending the turn, so this socket
  // is ours to release.
  assert.deepEqual(log, ["d:create", "d:finish", "d:close"]);
});

// Session reuse depends entirely on this contract: qwen-omni offers its
// connection to the pool immediately after `onEnd`, so a caller that closes on
// a clean end silently gets no reuse — no error, just a larger bill.
test("clientId reaches the provider, and a clean end leaves the socket alone", async () => {
  const timers = new FakeTimers();
  const log: string[] = [];
  const seen: Array<string | undefined> = [];

  const provider: ASRProvider = {
    createSession(callbacks) {
      seen.push((callbacks as { clientId?: string }).clientId);
      log.push("create");
      return {
        sendAudio() {},
        finish() {
          callbacks.onFinal?.("hi");
          callbacks.onEnd?.();
        },
        close() {
          log.push("close");
        },
      };
    },
  };

  await timers.runUntil(
    runTranscriptionJob({
      recording: endedRecording(),
      configurations: [definition("q/mock", provider)],
      env: {},
      clientId: "speaker-7",
      timers,
    })
  );

  assert.deepEqual(seen, ["speaker-7"]);
  assert.ok(!log.includes("close"), "a cleanly ended session must not be closed");
});

test("an aborted job still releases the socket", async () => {
  const timers = new FakeTimers();
  const log: string[] = [];
  const abort = new AbortController();
  const provider: ASRProvider = {
    createSession() {
      queueMicrotask(() => abort.abort());
      return {
        sendAudio() {},
        finish() {},
        close() {
          log.push("close");
        },
      };
    },
  };

  await assert.rejects(
    timers.runUntil(
      runTranscriptionJob({
        recording: endedRecording(),
        configurations: [definition("a/mock", provider)],
        env: {},
        maxAttempts: 1,
        signal: abort.signal,
        timers,
      })
    )
  );
  assert.deepEqual(log, ["close"]);
});

// A budget built from the returned result alone would under-count: the result
// carries only the winning attempt's usage, so every failed attempt's spend
// would be invisible. onAttemptFinished is what makes the ledger honest.
test("every attempt reports its usage, including the ones that failed", async () => {
  const timers = new FakeTimers();
  const log: string[] = [];
  const failing = scriptedProvider(log, "bad", (callbacks) => {
    // The vendor billed for the audio it processed before erroring.
    callbacks.onUsage?.([{ sku: "audio", unitPrice: 1, quantity: 4 }]);
    queueMicrotask(() => callbacks.onError?.(new Error("boom")));
    return {};
  });
  const succeeding = scriptedProvider(log, "good", (callbacks) => ({
    onFinish: () => {
      callbacks.onUsage?.([{ sku: "audio", unitPrice: 1, quantity: 1 }]);
      callbacks.onFinal?.("saved");
      callbacks.onEnd?.();
    },
  }));

  const finished: Array<{ attempt: number; ok: boolean; cost: number }> = [];
  const result = await timers.runUntil(
    runTranscriptionJob({
      recording: endedRecording(),
      configurations: [definition("bad/mock", failing), definition("good/mock", succeeding)],
      env: {},
      onAttemptFinished: (info) =>
        finished.push({
          attempt: info.attempt,
          ok: info.ok,
          cost: info.usage.reduce((n, r) => n + r.unitPrice * r.quantity, 0),
        }),
      timers,
    })
  );

  assert.deepEqual(finished, [
    { attempt: 1, ok: false, cost: 4 },
    { attempt: 2, ok: true, cost: 1 },
  ]);

  // The true spend is 5; the result alone would have claimed 1.
  const billed = finished.reduce((n, f) => n + f.cost, 0);
  const fromResult = result.usage.reduce((n, r) => n + r.unitPrice * r.quantity, 0);
  assert.equal(billed, 5);
  assert.equal(fromResult, 1);
});
