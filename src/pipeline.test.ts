import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { readPcm } from "vxasr/audio";
import type { AsrSetup } from "./asr-setup.ts";
import {
  UserAudioStream,
  type SegmentationOptions,
  type SpeechSegment,
} from "./user-audio-stream.ts";

/**
 * The receive path, end to end, with no Discord and no network: opus decode ->
 * downsample -> Silero VAD -> speech segments.
 *
 * Every unit below this was already covered with fakes, and the outage still
 * happened — the decoder blew up in the one seam nothing exercised. So this
 * test drives the real opus decoder, the real resampler and the real VAD model
 * over real speech (`testdata/speech.wav`, see `scripts/make-speech-fixture.ts`).
 */

// Resolved from the working directory; the task runs from the repo root.
const FIXTURE = join(process.cwd(), "testdata", "speech.wav");
/**
 * The same audio as real Discord-shaped Opus packets, committed rather than
 * encoded here. The only encoder available was `opusscript`, the package this
 * project removed for corrupting its own heap — a test that used it to prove
 * the decoder would rest on the very thing it replaced.
 */
const PACKETS = join(process.cwd(), "testdata", "speech.opus");

/** Length-prefixed packets, as written by scripts/make-opus-fixture.mjs. */
function readOpusPackets(bytes: Buffer): Buffer[] {
  const packets: Buffer[] = [];
  let offset = 0;
  while (offset + 2 <= bytes.length) {
    const length = bytes.readUInt16BE(offset);
    offset += 2;
    packets.push(bytes.subarray(offset, offset + length));
    offset += length;
  }
  return packets;
}
const asr = { configurations: [], env: {} } as unknown as AsrSetup;

interface Captured {
  bytes: number;
  finalized: boolean;
}

/**
 * Re-encodes the 16 kHz mono fixture as the 48 kHz stereo opus Discord sends,
 * then runs it through the stream and returns what was segmented.
 */
async function runPipeline(
  /** Milliseconds between packets. 0 feeds everything at once. */
  packetIntervalMs = 0,
  segmentation: SegmentationOptions = {}
): Promise<Captured[]> {
  const packets = readOpusPackets(readFileSync(PACKETS));

  const captured: Captured[] = [];
  const audioStream = new PassThrough();
  const stream = new UserAudioStream(
    "test-user",
    "test-key",
    {} as never,
    audioStream,
    asr,
    () => {},
    undefined, // no usage ledger in this test
    undefined, // no transcript collector in this test
    () => {
      const segment: Captured = { bytes: 0, finalized: false };
      captured.push(segment);
      return {
        addAudioData: (pcm: Buffer) => (segment.bytes += pcm.length),
        finalize: () => (segment.finalized = true),
      } satisfies SpeechSegment;
    },
    segmentation
  );

  // Fed as fast as the pipeline will take it. Segmentation is measured on the
  // audio clock, so the result must not depend on delivery speed — that is
  // exactly what the "faster than realtime" test below pins down.
  for (const packet of packets) {
    audioStream.write(packet);
    if (packetIntervalMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, packetIntervalMs));
    }
  }
  audioStream.end();

  // Wait for the stall detector to close the final utterance.
  await new Promise((resolve) => setTimeout(resolve, 2500));
  stream.destroy();
  return captured;
}

test("real speech survives decode, downsample and VAD as split segments", async () => {
  assert.ok(
    existsSync(FIXTURE),
    `missing ${FIXTURE} — regenerate it with scripts/make-speech-fixture.ts`
  );
  const { pcm, seconds } = readPcm(readFileSync(FIXTURE));
  assert.ok(seconds > 7, `fixture should be several seconds, got ${seconds}`);

  const captured = await runPipeline();

  // The fixture is two sentences with 1.6 s of silence between them, which is
  // longer than the VAD's 1 s silence window — so it must produce two
  // utterances, not one merged blob and not a segment per pause inside a
  // sentence.
  assert.equal(captured.length, 2, "expected one segment per sentence");
  assert.ok(
    captured.every((segment) => segment.finalized),
    "every segment must be finalized, or its transcript never gets requested"
  );

  const durations = captured.map((segment) => segment.bytes / 32000);
  for (const duration of durations) {
    assert.ok(
      duration > 1.5 && duration < 6,
      `each sentence should be a few seconds, got ${duration.toFixed(2)}s`
    );
  }

  // Speech must arrive close to intact: the pre-roll keeps the syllable that
  // woke the VAD, and nothing should truncate the tail.
  const captureRatio = durations.reduce((a, b) => a + b, 0) / seconds;
  assert.ok(
    captureRatio > 0.6,
    `captured only ${(captureRatio * 100).toFixed(0)}% of the audio`
  );
});

test("segmentation does not depend on how fast the packets arrive", async () => {
  // Utterance boundaries are a property of the speech, not of the network. This
  // used to be false: silence was measured with `Date.now()`, so a burst — a
  // reconnect catching up, or jitter — merged two sentences into one utterance,
  // and this test failed with 1 segment instead of 2.
  const instant = await runPipeline();
  const paced = await runPipeline(8); // 8 ms between 20 ms packets

  assert.equal(instant.length, 2);
  assert.deepEqual(
    paced.map((segment) => segment.finalized),
    instant.map((segment) => segment.finalized)
  );
  assert.equal(
    paced.length,
    instant.length,
    "a slower feed must produce the same segments as an instant one"
  );

  // The captured durations should match closely, not merely the segment count.
  instant.forEach((segment, index) => {
    const delta = Math.abs(segment.bytes - paced[index].bytes) / 32000;
    assert.ok(
      delta < 0.4,
      `segment ${index + 1} differs by ${delta.toFixed(2)}s between feed speeds`
    );
  });
});

// Impatience shrinks the pause needed to end an utterance as it lengthens, so
// a long one stops at a breath instead of waiting to be sliced by the cap.
test("a long utterance ends at a pause, before the cap can cut it", async () => {
  // A 4 s cap stands in for the real 120 s one: what matters is where the
  // utterance ends *relative to the budget*, and the fixture is 8 s long.
  const patient = await runPipeline(0, {
    maxUtteranceMs: 4000,
    minSilenceDuration: 1500, // impatience off: only the cap can split
  });
  const impatient = await runPipeline(0, {
    maxUtteranceMs: 4000,
    minSilenceDuration: 200,
  });

  const cap = 4000 * 32; // bytes of 16 kHz mono 16-bit audio in one cap window
  assert.ok(
    patient[0].bytes >= cap,
    `without impatience the cap should run to the end of its window, got ${patient[0].bytes}`
  );
  assert.ok(
    impatient[0].bytes < patient[0].bytes,
    `impatience should end the utterance earlier: ${impatient[0].bytes} vs ${patient[0].bytes}`
  );
  assert.ok(
    impatient[0].bytes < cap,
    "the earlier ending must come from a pause, not from the cap firing"
  );
  assert.ok(
    impatient.every((segment) => segment.finalized),
    "every segment must still be finalized, or its transcript is never requested"
  );
});

// The reason for the easing exponent: whatever impatience does to a monologue,
// it must do nothing at all to ordinary speech at the shipped settings.
test("ordinary speech segments exactly as it did before impatience", async () => {
  const withImpatience = await runPipeline();
  const without = await runPipeline(0, { minSilenceDuration: 1500 });

  assert.deepEqual(
    withImpatience.map((segment) => segment.bytes),
    without.map((segment) => segment.bytes),
    "at the default 120 s budget an 8 s fixture must be unaffected"
  );
});

test("speech that never pauses is split instead of growing without limit", async () => {
  // Nothing in the fixture pauses for the 1.5 s the VAD wants, within a
  // sentence — so with a 1 s cap the first sentence alone must be split, and
  // no audio may be dropped on the way.
  //
  // Impatience is switched off here (floor == ceiling) so this measures the
  // hard cap alone. With it on, these utterances would end on a short pause
  // first and the test could not say which of the two rules had acted.
  const noImpatience = { minSilenceDuration: 1500, silenceDuration: 1500 };
  const capped = await runPipeline(0, { ...noImpatience, maxUtteranceMs: 1000 });
  const uncapped = await runPipeline(0, noImpatience);

  assert.ok(
    capped.length > uncapped.length,
    `expected the cap to split utterances, got ${capped.length} vs ${uncapped.length}`
  );
  assert.ok(
    capped.every((segment) => segment.finalized),
    "every split segment must still be finalized, or its transcript is never requested"
  );

  // Splitting decides where messages break, it does not discard audio.
  const cappedAudio = capped.reduce((n, s) => n + s.bytes, 0);
  const uncappedAudio = uncapped.reduce((n, s) => n + s.bytes, 0);
  assert.ok(
    cappedAudio >= uncappedAudio * 0.95,
    `split kept ${cappedAudio} bytes vs ${uncappedAudio} unsplit — audio was lost`
  );
});
