/**
 * Injectable time source, so timing-sensitive logic (debounce, throttle,
 * backoff, pacing) can be tested deterministically with a fake clock.
 */
export interface Timers {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const realTimers: Timers = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

/**
 * Sleep that can be cut short. Resolves (never rejects) as soon as the signal
 * aborts, so callers check `signal.aborted` after awaiting rather than
 * handling a rejection in every loop.
 */
export function sleep(
  ms: number,
  options: { timers?: Timers; signal?: AbortSignal } = {}
): Promise<void> {
  const timers = options.timers ?? realTimers;
  const signal = options.signal;
  if (signal?.aborted) return Promise.resolve();

  return new Promise((resolve) => {
    const onAbort = () => {
      timers.clearTimeout(handle);
      resolve();
    };
    const handle = timers.setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
