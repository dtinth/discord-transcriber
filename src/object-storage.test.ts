import assert from "node:assert/strict";
import { test } from "node:test";
import { ObjectStorage } from "./object-storage.ts";

const config = {
  bucket: "meeting-audio",
  endpoint: "https://acct.r2.cloudflarestorage.com",
  region: "auto",
  accessKeyId: "AKIAEXAMPLE",
  secretAccessKey: "secret",
};

test("path-style addressing, so non-AWS providers work", () => {
  const storage = new ObjectStorage(config);
  assert.equal(
    storage.urlFor("recordings/2026-09-13/g1/s1/00000-m1.wav"),
    "https://acct.r2.cloudflarestorage.com/meeting-audio/recordings/2026-09-13/g1/s1/00000-m1.wav"
  );
});

test("a trailing slash on the endpoint does not double up", () => {
  const storage = new ObjectStorage({ ...config, endpoint: "https://acct.r2.cloudflarestorage.com/" });
  assert.ok(!storage.urlFor("a/b.wav").includes("com//"));
});

// A key is a path. Escaping its separators would bury every recording in one
// flat name, and not escaping the segments would break on odd characters.
test("key separators survive, segments are escaped", () => {
  const storage = new ObjectStorage(config);
  const url = storage.urlFor("rec/2026-09-13/a b+c.wav");
  assert.ok(url.endsWith("/rec/2026-09-13/a%20b%2Bc.wav"), url);
});

test("a presigned link carries a signature and the requested lifetime", async () => {
  const storage = new ObjectStorage(config);
  const url = new URL(await storage.presignGet("rec/one.wav", 86400));
  assert.equal(url.searchParams.get("X-Amz-Expires"), "86400");
  assert.equal(url.searchParams.get("X-Amz-Algorithm"), "AWS4-HMAC-SHA256");
  assert.ok((url.searchParams.get("X-Amz-Signature") ?? "").length > 0);
  assert.ok(url.pathname.includes("/meeting-audio/rec/one.wav"));
});

// Signing is arithmetic, not a request — which is what lets the index be
// built for an upload that has not landed yet.
test("presigning makes no network request", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = () => {
    throw new Error("presigning must not call the network");
  };
  try {
    const storage = new ObjectStorage(config);
    assert.ok((await storage.presignGet("rec/one.wav", 60)).includes("X-Amz-Signature"));
  } finally {
    globalThis.fetch = original;
  }
});

test("different keys sign differently", async () => {
  const storage = new ObjectStorage(config);
  const a = new URL(await storage.presignGet("rec/a.wav", 60));
  const b = new URL(await storage.presignGet("rec/b.wav", 60));
  assert.notEqual(
    a.searchParams.get("X-Amz-Signature"),
    b.searchParams.get("X-Amz-Signature")
  );
});

test("a failed PUT reports the status rather than passing silently", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = () =>
    Promise.resolve(new Response("AccessDenied", { status: 403 }));
  try {
    const storage = new ObjectStorage(config);
    await assert.rejects(
      () => storage.put("rec/one.wav", new Uint8Array([1, 2, 3]), "audio/wav"),
      /403/
    );
  } finally {
    globalThis.fetch = original;
  }
});

test("a successful PUT sends the bytes and the content type", async () => {
  const original = globalThis.fetch;
  let seen: { method?: string; type?: string | null; length: number } | null = null;
  globalThis.fetch = async (input: Request | URL | string, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    seen = {
      method: request.method,
      type: request.headers.get("content-type"),
      length: (await request.arrayBuffer()).byteLength,
    };
    return new Response("", { status: 200 });
  };
  try {
    const storage = new ObjectStorage(config);
    await storage.put("rec/one.wav", new Uint8Array(1234), "audio/wav");
    assert.equal(seen!.method, "PUT");
    assert.equal(seen!.type, "audio/wav");
    assert.equal(seen!.length, 1234);
  } finally {
    globalThis.fetch = original;
  }
});
