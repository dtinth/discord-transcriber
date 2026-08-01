import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { test } from "node:test";
import { Downsampler } from "./downsample.ts";

/** Build 48 kHz stereo PCM from per-frame [left, right] pairs. */
function stereo(frames: Array<[number, number]>): Buffer {
  const buffer = Buffer.alloc(frames.length * 4);
  frames.forEach(([left, right], i) => {
    buffer.writeInt16LE(left, i * 4);
    buffer.writeInt16LE(right, i * 4 + 2);
  });
  return buffer;
}

test("averages both channels and each group of three samples", () => {
  const downsampler = new Downsampler();
  const out = downsampler.push(
    stereo([
      [300, 100], // mono 200
      [500, 300], // mono 400
      [900, 300], // mono 600
    ])
  );
  assert.equal(out.length, 2);
  assert.equal(out.readInt16LE(0), 400); // (200+400+600)/3
});

test("output is 1/3 the mono sample count", () => {
  const downsampler = new Downsampler();
  const out = downsampler.push(stereo(Array.from({ length: 960 }, () => [0, 0])));
  assert.equal(out.length / 2, 320);
});

test("chunk boundaries do not change the output", () => {
  const frames: Array<[number, number]> = Array.from({ length: 100 }, (_, i) => [
    (i * 37) % 1000,
    (i * 91) % 1000,
  ]);

  const whole = new Downsampler().push(stereo(frames));

  const split = new Downsampler();
  const parts = [
    split.push(stereo(frames.slice(0, 7))),
    split.push(stereo(frames.slice(7, 50))),
    split.push(stereo(frames.slice(50))),
  ];
  const rejoined = Buffer.concat(parts);

  assert.deepEqual([...rejoined], [...whole]);
});
