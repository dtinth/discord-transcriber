import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import OpusScript from "opusscript";
import { readPcm } from "vxasr/audio";
import type { AsrSetup } from "./asr-setup.ts";
import { UserAudioStream, type SpeechSegment } from "./user-audio-stream.ts";

/**
 * The receive path, end to end, with no Discord and no network: opus decode ->
 * downsample -> Silero VAD -> speech segments.
 *
 * Every unit below this was already covered with fakes, and the outage still
 * happened — the decoder blew up in the one seam nothing exercised. So this
 * test drives the real opus decoder, the real resampler and the real VAD model
 * over real speech (`testdata/speech.wav`, see `scripts/make-speech-fixture.ts`).
 */

// Resolved from the working directory rather than from `import.meta.url`: the
// latter does not type-check under Deno here, and the obvious fix (a deno.json)
// risks moving Deno off this repo's `node_modules` — which is where
// `patches/opusscript.patch` lives. Both runners are invoked from the repo root.
const FIXTURE = join(process.cwd(), "testdata", "speech.wav");
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
  pcm16kMono: Buffer,
  /** Milliseconds between packets. 0 feeds everything at once. */
  packetIntervalMs = 0,
  maxUtteranceMs = 120_000
): Promise<Captured[]> {
  const encoder = new OpusScript(48000, 2, OpusScript.Application.AUDIO);
  const frames = Math.floor(pcm16kMono.length / 2 / 320); // 20 ms at 16 kHz
  const packets: Buffer[] = [];
  for (let f = 0; f < frames; f++) {
    const stereo = Buffer.alloc(960 * 2 * 2);
    for (let i = 0; i < 960; i++) {
      const sample = pcm16kMono.readInt16LE((f * 320 + Math.floor(i / 3)) * 2);
      stereo.writeInt16LE(sample, i * 4);
      stereo.writeInt16LE(sample, i * 4 + 2);
    }
    packets.push(encoder.encode(stereo, 960));
  }

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
    () => {
      const segment: Captured = { bytes: 0, finalized: false };
      captured.push(segment);
      return {
        addAudioData: (pcm: Buffer) => (segment.bytes += pcm.length),
        finalize: () => (segment.finalized = true),
      } satisfies SpeechSegment;
    },
    maxUtteranceMs
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

  const captured = await runPipeline(pcm);

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
  const { pcm } = readPcm(readFileSync(FIXTURE));

  const instant = await runPipeline(pcm);
  const paced = await runPipeline(pcm, 8); // 8 ms between 20 ms packets

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

test("speech that never pauses is split instead of growing without limit", async () => {
  // Nothing in the fixture pauses for the 1.5 s the VAD wants, within a
  // sentence — so with a 1 s cap the first sentence alone must be split, and
  // no audio may be dropped on the way.
  const { pcm } = readPcm(readFileSync(FIXTURE));
  const capped = await runPipeline(pcm, 0, 1000);
  const uncapped = await runPipeline(pcm);

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
