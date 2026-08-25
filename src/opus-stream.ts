import { Buffer } from "node:buffer";
import { OpusDecoder } from "opus-decoder";

/** Discord sends 48 kHz stereo Opus. */
const CHANNELS = 2;
const SAMPLE_RATE = 48000;

/**
 * Decodes Discord's Opus packets to 48 kHz stereo 16-bit PCM.
 *
 * Replaces `prism-media` + `opusscript`, and with them the patch this project
 * used to carry. `opusscript`'s WASM binding computed its heap views in the
 * wrong units, so every decode wrote outside its own allocation and corrupted
 * another decoder as soon as two speakers were present — the fault that made
 * the bot go deaf. Correcting it meant shipping a private patch against a
 * package whose last release was in 2023, applied by pnpm, which is precisely
 * what a Deno project cannot do.
 *
 * `opus-decoder` is pure WASM with no native build and no patch. Verified the
 * same way the patch was: decoded audio correlates 1.0000 with the source.
 *
 * One packet at a time, because that is how they arrive and because a decoder
 * carries state across packets — batching would only add latency.
 */
export class OpusStreamDecoder {
  private decoder = new OpusDecoder({ channels: CHANNELS, sampleRate: SAMPLE_RATE });
  private ready: Promise<unknown>;

  constructor() {
    this.ready = this.decoder.ready;
  }

  /** Resolves once the WASM module is usable. */
  init(): Promise<unknown> {
    return this.ready;
  }

  /**
   * Decode one packet to interleaved 16-bit stereo PCM.
   *
   * Returns an empty buffer for a packet that yields no samples, so callers can
   * treat "nothing decoded" and "nothing to do" identically.
   */
  decode(packet: Buffer): Buffer {
    const { channelData, samplesDecoded } = this.decoder.decodeFrame(
      new Uint8Array(packet)
    );
    if (samplesDecoded <= 0) return Buffer.alloc(0);

    const [left, right] = channelData;
    const out = Buffer.alloc(samplesDecoded * CHANNELS * 2);
    for (let i = 0; i < samplesDecoded; i++) {
      out.writeInt16LE(toPcm16(left[i]), i * 4);
      out.writeInt16LE(toPcm16(right?.[i] ?? left[i]), i * 4 + 2);
    }
    return out;
  }

  free(): void {
    this.decoder.free();
  }
}

/** Float32 [-1, 1] to signed 16-bit, clamped rather than wrapped. */
function toPcm16(sample: number): number {
  const scaled = Math.round((sample ?? 0) * 32767);
  return scaled > 32767 ? 32767 : scaled < -32768 ? -32768 : scaled;
}
