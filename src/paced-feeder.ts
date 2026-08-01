import { Buffer } from "node:buffer";
import type { ASRSession } from "vxasr";
import { BYTES_PER_SECOND } from "vxasr/audio";
import type { Recording } from "./recording.ts";
import { sleep, type Timers } from "./timers.ts";

/** One 100 ms frame of 16 kHz 16-bit mono PCM. */
export const FRAME_BYTES = BYTES_PER_SECOND / 10;

/** Realtime pacing for a provider not confirmed to accept a fast dump. */
export const FRAME_INTERVAL_MS = 100;

/**
 * Providers confirmed to accept a fast dump — audio sent back-to-back rather
 * than paced at realtime — without hanging or losing accuracy.
 *
 * Copied from vxbeamer's `apps/website/src/evalRun.ts` (`FAST_DUMP_PROVIDERS`),
 * which documents the discipline: a provider earns its entry by being tested
 * against `testdata/OBSERVATIONS.md`; an untested provider defaults to
 * realtime. The vxasr package does not export this set yet — when it does,
 * import it and delete this copy.
 */
export const FAST_DUMP_PROVIDERS: ReadonlySet<string> = new Set([
  "qwen",
  "qwen-omni",
  "byteplus",
  "mock",
]);

export interface FeedRecordingOptions {
  recording: Recording;
  session: Pick<ASRSession, "sendAudio" | "finish">;
  /** True when the provider is in {@link FAST_DUMP_PROVIDERS}. */
  fastDump: boolean;
  /** Aborting stops the feeder without calling `finish()`. */
  signal: AbortSignal;
  /** Injectable for tests. */
  timers?: Timers;
}

/**
 * Moves a cursor over the recording and feeds the session, unifying "live"
 * and "replay" in one code path:
 *
 * - **Live** (attempt 1): the cursor starts at 0 with little or no backlog
 *   and chases the tail. Audio arrives from Discord at realtime speed, so
 *   forwarding it as it arrives is realtime pacing by construction.
 * - **Replay** (a retry): the cursor starts at 0 over an already-full
 *   recording. A fast-dump provider gets the backlog back-to-back; any other
 *   provider gets one 100 ms frame per 100 ms — realtime — because feeding
 *   faster than the vendor was tested with is how sessions hang.
 *
 * Calls `finish()` exactly once, when the recording has ended and the cursor
 * has reached its end. Returns without `finish()` when aborted.
 */
export async function feedRecording(options: FeedRecordingOptions): Promise<void> {
  const { recording, session, fastDump, signal, timers } = options;
  let cursor = 0;

  while (!signal.aborted) {
    const chunk = recording.read(cursor, FRAME_BYTES);

    if (chunk) {
      session.sendAudio(Buffer.from(chunk));
      cursor += chunk.length;

      // Pace only a backlog. At the live tail (backlog 0) the next chunk's
      // arrival is the pacing, and a fast-dump provider needs no pacing at all.
      const backlog = recording.size - cursor;
      if (!fastDump && backlog > 0) {
        await sleep(FRAME_INTERVAL_MS, { timers, signal });
      }
    } else if (recording.isEnded) {
      session.finish();
      return;
    } else {
      await recording.waitForChange(signal);
    }
  }
}
