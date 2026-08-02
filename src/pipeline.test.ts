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
async function runPipeline(pcm16kMono: Buffer): Promise<Captured[]> {
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
    () => {
      const segment: Captured = { bytes: 0, finalized: false };
      captured.push(segment);
      return {
        addAudioData: (pcm: Buffer) => (segment.bytes += pcm.length),
        finalize: () => (segment.finalized = true),
      } satisfies SpeechSegment;
    }
  );

  // Fed at realtime, one 20 ms packet per 20 ms, because `UserAudioStream`
  // measures silence against the wall clock (`Date.now()`) rather than against
  // the audio it has consumed. A faster feed compresses the 1.6 s gap between
  // the sentences into a few milliseconds, and the two merge into one segment.
  // That coupling is why this test cannot be sped up without changing the
  // segmentation logic itself.
  for (const packet of packets) {
    audioStream.write(packet);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  audioStream.end();
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
