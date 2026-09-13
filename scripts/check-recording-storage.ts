/**
 * Pre-flight check for the recording archive.
 *
 * Proves the credentials, the endpoint, the region and the bucket policy all
 * work together *before* a meeting depends on them — the alternative is
 * finding out from a session whose audio was silently never uploaded.
 *
 * It writes one small object, reads it back through a presigned link, and
 * deletes it. Run it after setting the RECORDING_* variables:
 *
 *   deno task recording:check
 */
import config, { recordingStorageConfig } from "../src/config.ts";
import { ObjectStorage } from "../src/object-storage.ts";

const settings = recordingStorageConfig(config);
if (!settings) {
  console.error(
    "Recording archive is not configured. Set RECORDING_BUCKET, " +
      "RECORDING_ENDPOINT, RECORDING_ACCESS_KEY_ID and RECORDING_SECRET_ACCESS_KEY."
  );
  Deno.exit(1);
}

console.log(`bucket:   ${settings.bucket}`);
console.log(`endpoint: ${settings.endpoint}`);
console.log(`region:   ${settings.region}`);

const storage = new ObjectStorage(settings);
const key = `${config.RECORDING_PREFIX.replace(/\/+$/, "")}/_preflight/${Date.now()}.txt`;
const body = new TextEncoder().encode("discord-transcriber pre-flight\n");

console.log(`\nURL:      ${storage.urlFor(key)}`);

try {
  await storage.put(key, body, "text/plain");
  console.log("PUT       ok");
} catch (error) {
  console.error("PUT       FAILED:", error instanceof Error ? error.message : error);
  console.error(
    "\nCheck the access key, the secret, and that the endpoint is the region " +
      "host without the bucket in it."
  );
  Deno.exit(1);
}

const url = await storage.presignGet(key, 300);
console.log(`presigned ok (${url.length} chars, expires in 300s)`);

try {
  const response = await fetch(url);
  const text = await response.text();
  if (!response.ok) throw new Error(`${response.status} ${text.slice(0, 200)}`);
  if (!text.startsWith("discord-transcriber")) {
    throw new Error(`unexpected body: ${text.slice(0, 80)}`);
  }
  console.log("GET       ok (the signed link resolves)");
} catch (error) {
  console.error("GET       FAILED:", error instanceof Error ? error.message : error);
  console.error(
    "\nIf the PUT worked but this did not, the signature is being rejected on " +
      "read — usually RECORDING_REGION not matching the cluster."
  );
  Deno.exit(1);
}

// A public bucket would make the expiry meaningless: anyone could skip the
// signature and fetch the plain URL. Worth knowing before a meeting relies on it.
const bare = await fetch(storage.urlFor(key));
console.log(
  bare.ok
    ? "\nWARNING: the object is readable WITHOUT a signature. The bucket is public,\n" +
        "so the 24-hour link expiry protects nothing. Make the bucket private."
    : `\nbucket is private (unsigned read -> ${bare.status}), which is what you want`
);

await storage.delete(key);
console.log("cleaned up\n\nRecording storage is ready.");
