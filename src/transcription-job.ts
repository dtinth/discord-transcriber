import type {
  ASRProvider,
  ASRSession,
  ConfigurationDefinition,
  ProviderEnv,
  UsageRecord,
} from "vxasr";
import logger from "./logger.ts";
import { feedRecording } from "./paced-feeder.ts";
import type { Recording } from "./recording.ts";
import { realTimers, sleep, type Timers } from "./timers.ts";

/** Delay before attempts 2..5. Attempt 1 starts immediately. */
export const BACKOFF_SCHEDULE_MS: readonly number[] = [1000, 2000, 4000, 8000];

export const MAX_ATTEMPTS = 5;

/**
 * How long to wait for a final transcript after `finish()` was sent. A vendor
 * that hangs past this is treated as failed, so the retry loop can move on
 * instead of holding a message at "Transcribing…" forever.
 */
export const FINISH_TIMEOUT_MS = 30_000;

export interface TranscriptionResult {
  text: string;
  usage: UsageRecord[];
  configurationId: string;
  attempt: number;
}

export interface TranscriptionJobOptions {
  recording: Recording;
  /** Ordered model configurations; attempt i uses `list[(i-1) % length]`. */
  configurations: readonly ConfigurationDefinition[];
  env: ProviderEnv;
  /**
   * Identifies the speaker, so a provider that supports session reuse can hand
   * the same vendor connection to their next utterance (and with it, the
   * context of what they just said). Omitted, every turn opens a fresh one.
   */
  clientId?: string;
  onPartial?: (text: string) => void;
  onAttemptStart?: (attempt: number, configurationId: string) => void;
  maxAttempts?: number;
  backoffScheduleMs?: readonly number[];
  finishTimeoutMs?: number;
  /** Aborting gives up the whole job (e.g. the bot is shutting down). */
  signal?: AbortSignal;
  /** Injectable for tests. */
  timers?: Timers;
}

/**
 * The attempt loop: resolve a configuration, feed the recording through a
 * session, and on failure back off and try again — rotating through the
 * configured list — up to {@link MAX_ATTEMPTS} times. The recording is the
 * source of truth, so every attempt replays the same audio in full and no
 * sound is lost to a failed session.
 */
export async function runTranscriptionJob(
  options: TranscriptionJobOptions
): Promise<TranscriptionResult> {
  const {
    recording,
    configurations,
    env,
    clientId,
    onPartial,
    onAttemptStart,
    maxAttempts = MAX_ATTEMPTS,
    backoffScheduleMs = BACKOFF_SCHEDULE_MS,
    finishTimeoutMs = FINISH_TIMEOUT_MS,
    signal,
    timers,
  } = options;

  if (configurations.length === 0) {
    throw new Error("No ASR configurations to try");
  }

  let lastError: Error = new Error("Transcription failed");

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (signal?.aborted) break;

    const definition = configurations[(attempt - 1) % configurations.length];
    onAttemptStart?.(attempt, definition.id);

    try {
      const resolution = definition.resolve(env);
      if (!resolution.ok) {
        throw new Error(resolution.error.message);
      }

      const { text, usage } = await runAttempt({
        provider: resolution.provider,
        fastDump: definition.supportsFastDump,
        recording,
        onPartial,
        finishTimeoutMs,
        clientId,
        signal,
        timers,
      });

      return { text, usage, configurationId: definition.id, attempt };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      logger.warn(
        `Transcription attempt ${attempt}/${maxAttempts} (${definition.id}) failed:`,
        lastError.message
      );

      if (attempt < maxAttempts && !signal?.aborted) {
        const delay =
          backoffScheduleMs[Math.min(attempt - 1, backoffScheduleMs.length - 1)];
        await sleep(delay, { timers, signal });
      }
    }
  }

  throw lastError;
}

interface AttemptOptions {
  provider: ASRProvider;
  fastDump: boolean;
  recording: Recording;
  onPartial?: (text: string) => void;
  finishTimeoutMs: number;
  clientId?: string;
  signal?: AbortSignal;
  timers?: Timers;
}

/**
 * One session against one provider. Resolves with the transcript when the
 * session ends, rejects on session error, feeder error, or a vendor that goes
 * silent after `finish()`.
 *
 * The socket is always released, but *how* depends on the ending. A session
 * that ended on its own is left alone: the provider decides what to do with
 * its connection once the turn is over, and for `qwen-omni` with a `clientId`
 * that means offering it to the reuse pool. Calling `close()` there would
 * terminate the socket before the pool could take it, which disables reuse
 * silently — no error, just a quietly larger bill. Every other ending (error,
 * watchdog, abort) still closes, because nothing else will.
 */
function runAttempt(
  options: AttemptOptions
): Promise<{ text: string; usage: UsageRecord[] }> {
  const { provider, fastDump, recording, onPartial, finishTimeoutMs } = options;
  const timers = options.timers ?? realTimers;

  // Stops the feeder (and its pacing sleeps) the moment the attempt settles.
  const feederAbort = new AbortController();
  const abortFeeder = () => feederAbort.abort();
  options.signal?.addEventListener("abort", abortFeeder, { once: true });

  let session: ASRSession | null = null;
  let watchdog: unknown;
  /** True once the vendor ended the turn itself — see the note above. */
  let endedItself = false;

  return new Promise<{ text: string; usage: UsageRecord[] }>(
    (resolve, reject) => {
      const usage: UsageRecord[] = [];
      let finalText: string | null = null;
      let settled = false;
      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        fn();
      };

      session = provider.createSession({
        clientId: options.clientId,
        onPartial: (text) => onPartial?.(text),
        onFinal: (text) => {
          finalText = text;
        },
        onUsage: (records) => {
          usage.push(...records);
        },
        onEnd: () => {
          endedItself = true;
          settle(() => resolve({ text: finalText ?? "", usage }));
        },
        onError: (error) => settle(() => reject(error)),
      });

      feedRecording({
        recording,
        session,
        fastDump,
        signal: feederAbort.signal,
        timers: options.timers,
      })
        .then(() => {
          if (settled) return;

          // Aborted before `finish()` went out, so no vendor reply is coming.
          // This has to settle the attempt rather than return quietly: an
          // unsettled promise never reaches the `finally`, so the session would
          // never be closed and its socket would leak for the rest of the
          // process — against a vendor that caps concurrent connections.
          if (feederAbort.signal.aborted) {
            settle(() => reject(new Error("Transcription attempt was aborted")));
            return;
          }

          // `finish()` has been sent. A vendor that now goes silent would hang
          // this attempt forever without a watchdog. If a final transcript
          // already arrived, salvage it rather than retry.
          watchdog = timers.setTimeout(() => {
            settle(() => {
              if (finalText !== null) {
                resolve({ text: finalText, usage });
              } else {
                reject(
                  new Error(
                    `Vendor sent no result within ${finishTimeoutMs}ms of finish()`
                  )
                );
              }
            });
          }, finishTimeoutMs);
        })
        .catch((error) => settle(() => reject(error)));
    }
  ).finally(() => {
    options.signal?.removeEventListener("abort", abortFeeder);
    if (watchdog !== undefined) timers.clearTimeout(watchdog);
    abortFeeder();
    if (!endedItself) session?.close();
  });
}
