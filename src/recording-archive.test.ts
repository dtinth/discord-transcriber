import assert from "node:assert/strict";
import { test } from "node:test";
import type { ObjectStorage } from "./object-storage.ts";
import { RecordingArchive } from "./recording-archive.ts";

function fakeStorage(options: { failOn?: (key: string) => boolean } = {}) {
  const puts: Array<{ key: string; bytes: number }> = [];
  const storage = {
    urlFor: (key: string) => `https://example.test/bucket/${key}`,
    put: (key: string, body: Uint8Array) => {
      if (options.failOn?.(key)) return Promise.reject(new Error("denied"));
      puts.push({ key, bytes: body.byteLength });
      return Promise.resolve();
    },
    presignGet: (key: string, ttl: number) =>
      Promise.resolve(`https://example.test/bucket/${key}?X-Amz-Expires=${ttl}&X-Amz-Signature=sig`),
  } as unknown as ObjectStorage;
  return { storage, puts };
}

function upload(overrides: Record<string, unknown> = {}) {
  return {
    speakerId: "42",
    startedAt: Date.parse("2026-09-13T10:00:00Z"),
    endedAt: Date.parse("2026-09-13T10:00:04Z"),
    messageId: "m1",
    wav: new Uint8Array(1024),
    seconds: 4,
    ...overrides,
  } as never;
}

const DAY = new Date("2026-09-13T09:00:00Z");

test("the key is dated first, so a lifecycle rule can expire whole days", () => {
  const { storage, puts } = fakeStorage();
  const archive = new RecordingArchive(storage, "recordings", "g1", "s1", DAY);
  archive.archive(upload());
  assert.equal(puts[0].key, "recordings/2026-09-13/g1/s1/00000-m1.wav");
});

test("ordinals keep a bucket listing in the order people spoke", () => {
  const { storage, puts } = fakeStorage();
  const archive = new RecordingArchive(storage, "recordings", "g1", "s1", DAY);
  archive.archive(upload({ messageId: "m1" }));
  archive.archive(upload({ messageId: "m2" }));
  assert.deepEqual(
    puts.map((p) => p.key.split("/").pop()),
    ["00000-m1.wav", "00001-m2.wav"]
  );
});

test("an utterance with no message id still gets a unique key", () => {
  const { storage, puts } = fakeStorage();
  const archive = new RecordingArchive(storage, "recordings", "g1", "s1", DAY);
  archive.archive(upload({ messageId: null, startedAt: 1700000000000 }));
  assert.ok(puts[0].key.endsWith("00000-t1700000000000.wav"), puts[0].key);
});

test("an empty prefix does not produce a leading slash", () => {
  const { storage, puts } = fakeStorage();
  const archive = new RecordingArchive(storage, "", "g1", "s1", DAY);
  archive.archive(upload());
  assert.equal(puts[0].key, "2026-09-13/g1/s1/00000-m1.wav");
});

// The transcript is the file that cannot be rebuilt. An upload that fails must
// not take it down, and must not stall the drain either.
test("a failed upload is logged, not thrown, and still settles the drain", async () => {
  const { storage } = fakeStorage({ failOn: () => true });
  const archive = new RecordingArchive(storage, "rec", "g1", "s1", DAY);
  assert.doesNotThrow(() => archive.archive(upload()));
  assert.equal(await archive.drain(1000), 0, "a failure must not hold the drain open");
});

// The row survives a failed upload on purpose: a link that 404s says an
// utterance existed, where a missing row would hide it.
test("a failed upload still appears in the index", async () => {
  const { storage } = fakeStorage({ failOn: () => true });
  const archive = new RecordingArchive(storage, "rec", "g1", "s1", DAY);
  archive.archive(upload());
  await archive.drain(1000);
  assert.equal(archive.size, 1);
  assert.ok((await archive.toCsv(60)).includes("X-Amz-Signature"));
});

test("the index carries the columns needed to join it to the transcript", async () => {
  const { storage } = fakeStorage();
  const archive = new RecordingArchive(storage, "rec", "g1", "s1", DAY);
  archive.archive(upload());
  await archive.drain(1000);

  const csv = await archive.toCsv(86400);
  const [header, row] = csv.trimEnd().split("\r\n");
  assert.equal(
    header,
    "started_at,ended_at,message_id,speaker_id,seconds,bytes,audio_url"
  );
  const fields = row.split(",");
  assert.equal(fields[0], "2026-09-13T10:00:00.000Z");
  assert.equal(fields[2], "m1", "message_id joins this to the transcript CSV");
  assert.equal(fields[3], "42");
  assert.ok(row.includes("X-Amz-Expires=86400"));
});

test("nothing archived means no index at all", async () => {
  const { storage } = fakeStorage();
  const archive = new RecordingArchive(storage, "rec", "g1", "s1", DAY);
  assert.equal(archive.size, 0);
});

test("in-flight uploads are counted while they run", async () => {
  let release: () => void = () => {};
  const blocked = new Promise<void>((r) => (release = r));
  const storage = {
    put: () => blocked,
    presignGet: (k: string) => Promise.resolve(`https://x/${k}`),
    urlFor: (k: string) => k,
  } as unknown as ObjectStorage;

  const archive = new RecordingArchive(storage, "rec", "g1", "s1", DAY);
  archive.archive(upload());
  assert.equal(archive.inFlight, 1);
  release();
  assert.equal(await archive.drain(1000), 0);
  assert.equal(archive.inFlight, 0);
});
