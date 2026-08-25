/**
 * Counts utterances that are still at the vendor, so `!stop` knows when the
 * transcript is complete.
 *
 * Its own module for the same reason `SpeakerRegistry` is: this is bookkeeping,
 * and bookkeeping is where the expensive mistakes have been. An over-count here
 * makes `!stop` wait out its whole timeout on every use; an under-count sends a
 * file that is quietly missing the end of the meeting. Neither announces itself.
 */
export class PendingUtterances {
  private count = 0;

  get size(): number {
    return this.count;
  }

  started(): void {
    this.count++;
  }

  /** Never goes below zero: a double finish must not mask a real pending one. */
  finished(): void {
    if (this.count > 0) this.count--;
  }

  /**
   * Waits until nothing is outstanding, or the timeout expires.
   *
   * Resolves with what was still outstanding — 0 when everything landed. The
   * caller reports a non-zero result rather than pretending the file is whole.
   */
  async drain(
    timeoutMs: number,
    options: { pollMs?: number; now?: () => number; sleep?: (ms: number) => Promise<void> } = {}
  ): Promise<number> {
    const pollMs = options.pollMs ?? 250;
    const now = options.now ?? (() => Date.now());
    const sleep =
      options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

    const deadline = now() + timeoutMs;
    while (this.count > 0 && now() < deadline) {
      await sleep(pollMs);
    }
    return this.count;
  }
}
