export interface SpeakerStream {
  destroy(): void;
}

/**
 * Tracks which speakers currently have a live audio stream, so the bot opens
 * exactly one per person and picks them up again once it ends.
 *
 * This is deliberately free of Discord (and of the audio pipeline): the rule it
 * enforces is bookkeeping, and bookkeeping is where the bot's worst failure
 * lived. A decoder blew up during stream setup, the speaker was left marked
 * active with no stream to ever release them, and every later utterance from
 * that person was dropped — the bot stayed connected and silently transcribed
 * nothing. Keeping this logic testable without a voice connection is the point.
 */
export class SpeakerRegistry {
  private streams = new Map<string, SpeakerStream>();

  /** Speakers with a live stream. */
  get size(): number {
    return this.streams.size;
  }

  has(userId: string): boolean {
    return this.streams.has(userId);
  }

  /**
   * Open a stream for `userId`, unless one is already live.
   *
   * `start` receives the `onEnd` callback the stream must invoke when it
   * finishes, which releases the speaker's slot. If `start` throws, the slot is
   * released before the error propagates — a failed setup must never leave a
   * speaker permanently ignored.
   *
   * Returns true when a stream was opened.
   */
  start(
    userId: string,
    start: (onEnd: () => void) => SpeakerStream
  ): boolean {
    if (this.streams.has(userId)) return false;

    // Released at most once, and only while this stream is still the live one —
    // a late release from a superseded stream must not free a newer stream's
    // slot, or the bot would run two concurrent streams for one speaker.
    let released = false;
    const onEnd = () => {
      if (released) return;
      released = true;
      if (this.streams.get(userId) === stream) this.streams.delete(userId);
    };

    let stream: SpeakerStream;
    try {
      stream = start(onEnd);
    } catch (error) {
      this.streams.delete(userId);
      throw error;
    }

    // `start` may have already ended (and released) synchronously; only record
    // the stream if it is still meant to be live.
    if (!released) this.streams.set(userId, stream);
    return true;
  }

  /** Destroy every live stream. Errors from one do not stop the others. */
  destroyAll(onError?: (error: unknown) => void): void {
    for (const stream of [...this.streams.values()]) {
      try {
        stream.destroy();
      } catch (error) {
        onError?.(error);
      }
    }
    this.streams.clear();
  }
}
