import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { test } from "node:test";
import { Recording } from "./recording.ts";

test("append and read across growth boundaries", () => {
  const recording = new Recording(4);
  recording.append(Buffer.from([1, 2, 3]));
  recording.append(Buffer.from([4, 5, 6, 7, 8]));

  assert.equal(recording.size, 8);
  assert.deepEqual([...recording.read(0, 8)!], [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual([...recording.read(6, 100)!], [7, 8]);
  assert.equal(recording.read(8, 100), null);
});

test("read clamps to what exists", () => {
  const recording = new Recording();
  recording.append(Buffer.from([9, 9]));
  assert.deepEqual([...recording.read(0, 1)!], [9]);
  assert.equal(recording.read(2, 1), null);
});

test("views stay valid after the backing buffer grows", () => {
  const recording = new Recording(4);
  recording.append(Buffer.from([1, 2, 3, 4]));
  const view = recording.read(0, 4)!;
  recording.append(Buffer.alloc(1024, 7)); // forces reallocation
  assert.deepEqual([...view], [1, 2, 3, 4]);
});

test("end is idempotent and rejects further appends", () => {
  const recording = new Recording();
  recording.end();
  recording.end();
  assert.equal(recording.isEnded, true);
  assert.throws(() => recording.append(Buffer.from([1])));
});

test("waitForChange resolves on append, end, and abort", async () => {
  const recording = new Recording();

  let appended = false;
  const wait1 = recording.waitForChange().then(() => {
    appended = true;
  });
  recording.append(Buffer.from([1]));
  await wait1;
  assert.equal(appended, true);

  const abort = new AbortController();
  const wait2 = recording.waitForChange(abort.signal);
  abort.abort();
  await wait2; // resolves rather than hangs

  recording.end();
  await recording.waitForChange(); // already ended: resolves immediately
});

test("toBuffer copies exactly the recorded bytes", () => {
  const recording = new Recording(4);
  recording.append(Buffer.from([1, 2, 3, 4, 5]));
  const copy = recording.toBuffer();
  assert.deepEqual([...copy], [1, 2, 3, 4, 5]);
});
