import { setImmediate } from "node:timers";
import type { Timers } from "./timers.ts";

/**
 * Deterministic clock for tests. Implements {@link Timers}; time moves only
 * through `advance()`, which runs due callbacks in order and drains the
 * microtask queue between them so promise chains progress.
 */
export class FakeTimers implements Timers {
  private time = 0;
  private nextId = 1;
  private scheduled: Array<{ id: number; at: number; fn: () => void }> = [];

  now(): number {
    return this.time;
  }

  setTimeout(fn: () => void, ms: number): unknown {
    const id = this.nextId++;
    this.scheduled.push({ id, at: this.time + ms, fn });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.scheduled = this.scheduled.filter((entry) => entry.id !== handle);
  }

  get pendingCount(): number {
    return this.scheduled.length;
  }

  /** Advance the clock, firing due timers in timestamp order. */
  async advance(ms: number): Promise<void> {
    const target = this.time + ms;
    for (;;) {
      await drainMicrotasks();
      const due = this.scheduled
        .filter((entry) => entry.at <= target)
        .sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!due) break;
      this.scheduled = this.scheduled.filter((entry) => entry.id !== due.id);
      this.time = due.at;
      due.fn();
    }
    this.time = target;
    await drainMicrotasks();
  }

  /**
   * Keep firing timers until the promise settles. Throws if the promise is
   * still pending when no timers remain — that means the code under test hung.
   */
  async runUntil<T>(promise: Promise<T>): Promise<T> {
    let settled = false;
    const tracked = promise.finally(() => {
      settled = true;
    });
    // Swallow here; the caller gets the rejection from `tracked`.
    tracked.catch(() => {});

    for (;;) {
      await drainMicrotasks();
      if (settled) return tracked;
      const next = this.scheduled.sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!next) {
        await drainMicrotasks();
        if (settled) return tracked;
        throw new Error("Promise did not settle and no timers are scheduled");
      }
      await this.advance(next.at - this.time);
    }
  }
}

/** Let pending promise callbacks run (several macrotask turns). */
export async function drainMicrotasks(turns = 5): Promise<void> {
  for (let i = 0; i < turns; i++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}
