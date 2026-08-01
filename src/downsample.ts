import { Buffer } from "node:buffer";

/**
 * Streaming 48 kHz stereo → 16 kHz mono converter for 16-bit signed PCM.
 *
 * The ratio is exactly 3:1, so each output sample is the average of three
 * consecutive mono samples (each itself the average of left and right). The
 * averaging doubles as a crude low-pass filter, which plain decimation — what
 * this replaces — did not have. Carries up to two leftover samples across
 * calls, so chunk boundaries do not affect the output.
 *
 * (vxasr exports a general `LinearResampler`, but it interpolates without a
 * low-pass — built for upsampling. For 3:1 downsampling, group averaging is
 * the better fit, so this stays.)
 */
export class Downsampler {
  private leftover: number[] = [];

  push(stereo48k: Buffer): Buffer {
    const frames = Math.floor(stereo48k.length / 4);
    const mono = this.leftover;

    for (let i = 0; i < frames; i++) {
      const left = stereo48k.readInt16LE(i * 4);
      const right = stereo48k.readInt16LE(i * 4 + 2);
      mono.push((left + right) / 2);
    }

    const outSamples = Math.floor(mono.length / 3);
    const out = Buffer.alloc(outSamples * 2);
    for (let i = 0; i < outSamples; i++) {
      const average = (mono[i * 3] + mono[i * 3 + 1] + mono[i * 3 + 2]) / 3;
      out.writeInt16LE(Math.round(average), i * 2);
    }

    this.leftover = mono.slice(outSamples * 3);
    return out;
  }
}
