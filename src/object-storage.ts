import { AwsClient } from "aws4fetch";

/**
 * Credentials and location of the bucket recordings are archived to.
 *
 * Supplying these is what turns archiving on — there is no separate switch, so
 * a deployment without keys keeps its current behaviour and stores nothing.
 */
export interface ObjectStorageConfig {
  bucket: string;
  /**
   * The service endpoint, without the bucket: an S3-compatible base such as
   * `https://<account>.r2.cloudflarestorage.com` or
   * `https://s3.us-east-1.amazonaws.com`.
   */
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
}

/**
 * The little of S3 this project needs: put an object, and hand out a link to
 * read it back.
 *
 * `aws4fetch` rather than the AWS SDK — it is a few kilobytes, signs with the
 * platform's own crypto and fetch, and needs no Node shims. The SDK would be
 * two orders of magnitude more dependency for `PutObject` and a presigner.
 *
 * Addressing is path-style (`endpoint/bucket/key`). Virtual-host style would
 * break every S3-compatible provider that is not AWS, and R2 and MinIO are
 * the likely targets here.
 */
export class ObjectStorage {
  private client: AwsClient;

  constructor(private config: ObjectStorageConfig) {
    this.client = new AwsClient({
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      service: "s3",
      region: config.region,
    });
  }

  /**
   * The object's URL. Each path segment is escaped, but the separators are
   * not — a key is a path, and encoding its slashes would bury every
   * recording in one flat name.
   */
  urlFor(key: string): string {
    const path = key
      .split("/")
      .map((segment) => encodeURIComponent(segment))
      .join("/");
    return `${this.config.endpoint.replace(/\/+$/, "")}/${this.config.bucket}/${path}`;
  }

  async put(
    key: string,
    body: Uint8Array,
    contentType = "application/octet-stream"
  ): Promise<void> {
    // Copied into an ArrayBuffer-backed view rather than cast. A Uint8Array
    // may sit on a SharedArrayBuffer, which is not a valid request body, and
    // the copy says so honestly where a cast would only silence it. An
    // utterance is a few hundred kilobytes, so the copy does not matter.
    const bytes = new Uint8Array(body.byteLength);
    bytes.set(body);
    const response = await this.client.fetch(this.urlFor(key), {
      method: "PUT",
      body: bytes,
      headers: { "content-type": contentType, "content-length": String(body.length) },
    });
    if (!response.ok) {
      throw new Error(
        `PUT ${key} -> ${response.status} ${(await response.text()).slice(0, 200)}`
      );
    }
  }

  /**
   * A link that reads the object back, valid for `ttlSeconds`.
   *
   * Signing is arithmetic over the key and the expiry — no request is made,
   * and **the object need not exist yet**. That is what lets the session's
   * index be built without waiting on every upload.
   */
  async presignGet(key: string, ttlSeconds: number): Promise<string> {
    const url = new URL(this.urlFor(key));
    url.searchParams.set("X-Amz-Expires", String(ttlSeconds));
    const signed = await this.client.sign(url.toString(), {
      method: "GET",
      aws: { signQuery: true },
    });
    return signed.url;
  }
}
