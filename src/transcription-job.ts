import type {
  ASRProvider,
  ASRSession,
  ConfigurationDefinition,
  ProviderEnv,
  UsageRecord,
} from "vxasr";
import logger from "./logger.ts";
import { FAST_DUMP_PROVIDERS, feedRecording } from "./paced-feeder.ts";
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
        fastDump: FAST_DUMP_PROVIDERS.has(definition.providerId),
        recording,
        onPartial,
        finishTimeoutMs,
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
  signal?: AbortSignal;
  timers?: Timers;
}

/**
 * One session against one provider. Resolves with the transcript when the
 * session ends, rejects on session error, feeder error, or a vendor that goes
 * silent after `finish()`. The session's socket is always released: `close()`
 * runs in the `finally`, and is idempotent for a session that already ended.
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
        onPartial: (text) => onPartial?.(text),
        onFinal: (text) => {
          finalText = text;
        },
        onUsage: (records) => {
          usage.push(...records);
        },
        onEnd: () => settle(() => resolve({ text: finalText ?? "", usage })),
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
          // `finish()` has been sent (unless aborted). A vendor that now goes
          // silent would hang this attempt forever without a watchdog. If a
          // final transcript already arrived, salvage it rather than retry.
          if (settled || feederAbort.signal.aborted) return;
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
    session?.close();
  });
}
