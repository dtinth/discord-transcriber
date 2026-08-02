import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { test } from "node:test";
import OpusScript from "opusscript";

/**
 * Guards `patches/opusscript.patch`.
 *
 * opusscript built its PCM heap views with `HEAPU16.subarray(bytePointer, …)`,
 * but `Uint16Array` indices count 16-bit elements while `_malloc` returns a byte
 * address. Each decoder therefore wrote its PCM at twice its own address, over
 * another decoder's opus state as soon as a process held more than one. That
 * corrupted state tripped an assertion inside opus, and Emscripten's `abort()`
 * killed the shared WASM module — after which every opus call in the process
 * threw `Aborted()` and the bot decoded nothing while still connected to voice.
 *
 * A single decoder cannot detect this: `decode()` reads its result back through
 * the same wrong view it wrote to, so the mistake cancels itself and the audio
 * is correct. Only a second decoder makes the collision visible, which is why
 * these tests use several — one per speaker, as a busy voice channel has.
 */

const RATE = 48000;
const CHANNELS = 2;
const FRAME = 960; // 20 ms, the frame size Discord sends

/**
 * The allocation internals the patch corrects. opusscript's own typings do not
 * declare them, but they are exactly what this regression is about, so the test
 * reaches for them deliberately rather than asserting only on behaviour.
 */
interface OpusScriptHeap {
  inPCM: Uint16Array;
  inPCMPointer: number;
  inPCMLength: number;
  outPCM: Uint16Array;
  outPCMPointer: number;
  outPCMLength: number;
}

const heapOf = (codec: OpusScript) => codec as unknown as OpusScriptHeap;

function toneFrame(offset = 0): Buffer {
  const pcm = Buffer.alloc(FRAME * CHANNELS * 2);
  for (let i = 0; i < FRAME * CHANNELS; i++) {
    pcm.writeInt16LE(Math.round(9000 * Math.sin((i + offset) / 15)), i * 2);
  }
  return pcm;
}

test("heap views match their allocations", () => {
  const heap = heapOf(new OpusScript(RATE, CHANNELS, OpusScript.Application.AUDIO));

  // The address handed to the WASM decoder must be the address that was
  // allocated, and the view must not extend past the allocation.
  assert.equal(heap.outPCM.byteOffset, heap.outPCMPointer);
  assert.equal(heap.outPCM.byteLength, heap.outPCMLength);
  assert.equal(heap.inPCM.byteOffset, heap.inPCMPointer);
  assert.equal(heap.inPCM.byteLength, heap.inPCMLength);
});

test("many decoders share the WASM heap without corrupting each other", () => {
  const encoder = new OpusScript(RATE, CHANNELS, OpusScript.Application.AUDIO);
  const packet = encoder.encode(toneFrame(), FRAME);

  // Unpatched, six decoders abort within a second of interleaved decoding.
  const decoders = Array.from({ length: 8 }, () =>
    new OpusScript(RATE, CHANNELS, OpusScript.Application.AUDIO)
  );

  for (let round = 0; round < 250; round++) {
    for (const decoder of decoders) {
      const pcm = decoder.decode(packet);
      assert.equal(pcm.length, FRAME * CHANNELS * 2);
    }
  }
});

test("decoded audio reproduces the source, not just non-crashing bytes", () => {
  // A wrong pointer that happens not to crash would be worse than one that
  // does, so assert on the audio itself rather than on survival.
  const encoder = new OpusScript(RATE, CHANNELS, OpusScript.Application.AUDIO);
  const decoder = new OpusScript(RATE, CHANNELS, OpusScript.Application.AUDIO);

  const frames = 40;
  const source = Buffer.concat(
    Array.from({ length: frames }, (_, f) => toneFrame(f * FRAME * CHANNELS))
  );

  const decoded = Buffer.concat(
    Array.from({ length: frames }, (_, f) =>
      decoder.decode(
        encoder.encode(
          source.subarray(f * FRAME * CHANNELS * 2, (f + 1) * FRAME * CHANNELS * 2),
          FRAME
        )
      )
    )
  );
  assert.equal(decoded.length, source.length);

  // opus delays the signal by a few ms, so correlate over a lag search.
  const samples = FRAME * frames * CHANNELS;
  const window = samples - 4000;
  let best = 0;
  for (let lag = 0; lag < 1200; lag++) {
    let dot = 0;
    let na = 0;
    let nb = 0;
    for (let i = 0; i < window; i++) {
      const a = source.readInt16LE(i * 2);
      const b = decoded.readInt16LE((i + lag) * 2);
      dot += a * b;
      na += a * a;
      nb += b * b;
    }
    best = Math.max(best, dot / Math.sqrt(na * nb));
  }

  assert.ok(best > 0.95, `decoded audio correlates only ${best.toFixed(4)} with the source`);
});
