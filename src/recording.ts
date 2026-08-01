import { Buffer } from "node:buffer";

/**
 * The audio of one utterance: an append-only buffer of 16 kHz 16-bit mono PCM.
 *
 * This is the source of truth for transcription. Sessions never own audio —
 * they read from here through a cursor (see `paced-feeder.ts`) — so a failed
 * session loses nothing and a retry simply reads from offset 0 again.
 *
 * Written bytes are immutable: `read` may return views into the backing
 * buffer, which stay valid because a region is never rewritten once appended
 * (growth allocates a new backing buffer and copies, leaving old views
 * pointing at identical bytes).
 */
export class Recording {
  private buffer: Buffer;
  private byteLength = 0;
  private ended = false;
  private waiters: Array<() => void> = [];

  constructor(initialCapacity = 64 * 1024) {
    this.buffer = Buffer.alloc(initialCapacity);
  }

  /** Total bytes recorded so far. */
  get size(): number {
    return this.byteLength;
  }

  /** True once `end()` was called; no more audio will arrive. */
  get isEnded(): boolean {
    return this.ended;
  }

  /** Append PCM. Throws if the recording already ended — that is a bug. */
  append(chunk: Buffer): void {
    if (this.ended) {
      throw new Error("Cannot append to an ended recording");
    }
    if (chunk.length === 0) return;

    this.ensureCapacity(this.byteLength + chunk.length);
    chunk.copy(this.buffer, this.byteLength);
    this.byteLength += chunk.length;
    this.notify();
  }

  /** Mark the recording complete. Idempotent. */
  end(): void {
    if (this.ended) return;
    this.ended = true;
    this.notify();
  }

  /**
   * Read up to `maxBytes` starting at `offset`. Returns `null` when no data
   * is available there yet — the caller distinguishes "wait for more" from
   * "done" via `isEnded`.
   */
  read(offset: number, maxBytes: number): Buffer | null {
    if (offset >= this.byteLength) return null;
    const end = Math.min(this.byteLength, offset + maxBytes);
    return this.buffer.subarray(offset, end);
  }

  /** A copy of the full recording, e.g. for writing a WAV file. */
  toBuffer(): Buffer {
    return Buffer.from(this.buffer.subarray(0, this.byteLength));
  }

  /**
   * Resolves on the next `append` or `end` — or immediately if the recording
   * already ended or the signal aborts. Never rejects; callers re-check state.
   */
  waitForChange(signal?: AbortSignal): Promise<void> {
    if (this.ended || signal?.aborted) return Promise.resolve();

    return new Promise((resolve) => {
      const waiter = () => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      };
      const onAbort = () => {
        const index = this.waiters.indexOf(waiter);
        if (index !== -1) this.waiters.splice(index, 1);
        resolve();
      };
      this.waiters.push(waiter);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  private ensureCapacity(required: number): void {
    if (required <= this.buffer.length) return;
    let capacity = this.buffer.length * 2;
    while (capacity < required) capacity *= 2;
    const grown = Buffer.alloc(capacity);
    this.buffer.copy(grown, 0, 0, this.byteLength);
    this.buffer = grown;
  }

  private notify(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const waiter of waiters) waiter();
  }
}
