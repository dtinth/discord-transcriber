/**
 * Fails loudly if this build cannot actually transcribe.
 *
 * Run in the Docker build and in CI. Both checks guard failures that are
 * invisible at build time and only surface when somebody speaks — the worst
 * kind to ship:
 *
 * 1. **The audio path decodes correctly.** Not "the module loads": the previous
 *    decoder loaded perfectly and wrote outside its own memory. So this decodes
 *    real Opus packets and compares the result with the original audio.
 * 2. **The VAD initialises.** It is a native Node-API module with a
 *    per-architecture binary; the wrong one gives a bot that joins the channel
 *    and hears nothing.
 */
import { NonRealTimeVAD } from "@ricky0123/vad-node";
import { OpusStreamDecoder } from "../src/opus-stream.ts";

const problems: string[] = [];

try {
  const packets = readPackets(Deno.readFileSync("testdata/speech.opus"));
  const source = Deno.readFileSync("testdata/speech.wav").slice(44);

  const decoder = new OpusStreamDecoder();
  await decoder.init();

  const decoded: number[] = [];
  for (const packet of packets) {
    const pcm = decoder.decode(Buffer.from(packet));
    // Left channel only, and 48 kHz -> 16 kHz, to compare with the source.
    for (let i = 0; i + 3 < pcm.length; i += 4 * 3) {
      decoded.push(pcm.readInt16LE(i));
    }
  }
  decoder.free();

  const r = bestCorrelation(source, decoded);
  if (!(r > 0.9)) {
    problems.push(`audio decodes incorrectly: correlation ${r.toFixed(4)} with the source`);
  } else {
    console.log(`audio path OK — correlation ${r.toFixed(4)}`);
  }
} catch (error) {
  problems.push(`opus decoding failed: ${(error as Error).message}`);
}

try {
  await NonRealTimeVAD.new({ frameSamples: 1024 });
  console.log("VAD OK — model initialised");
} catch (error) {
  problems.push(`Silero VAD failed to initialise: ${(error as Error).message}`);
}

if (problems.length > 0) {
  console.error("Runtime verification FAILED:");
  for (const p of problems) console.error(" -", p);
  Deno.exit(1);
}
console.log("Runtime verification OK");

/** Length-prefixed packets, as written by scripts/make-opus-fixture.mjs. */
function readPackets(bytes: Uint8Array): Uint8Array[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const packets: Uint8Array[] = [];
  let offset = 0;
  while (offset + 2 <= bytes.length) {
    const length = view.getUint16(offset);
    offset += 2;
    packets.push(bytes.subarray(offset, offset + length));
    offset += length;
  }
  return packets;
}

/** Opus delays the signal, so compare over a lag search rather than head-on. */
function bestCorrelation(sourcePcm: Uint8Array, decoded: number[]): number {
  const src = new DataView(sourcePcm.buffer, sourcePcm.byteOffset, sourcePcm.byteLength);
  const total = Math.min(Math.floor(sourcePcm.length / 2), decoded.length) - 2000;
  let best = 0;
  for (let lag = 0; lag < 400; lag++) {
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < total; i++) {
      const a = src.getInt16(i * 2, true);
      const b = decoded[i + lag] ?? 0;
      dot += a * b; na += a * a; nb += b * b;
    }
    const r = dot / Math.sqrt(na * nb);
    if (r > best) best = r;
  }
  return best;
}
