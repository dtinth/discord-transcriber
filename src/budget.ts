import type { BudgetPeriod, UsageStore } from "./usage-store.ts";

export interface BudgetLimits {
  /** Spend cap across every guild. 0 or undefined disables the global cap. */
  totalUsd?: number;
  /** Optional per-guild cap, so one server cannot consume the whole budget. */
  perGuildUsd?: number;
  period: BudgetPeriod;
}

export type BudgetVerdict =
  | { allowed: true }
  | {
      allowed: false;
      /** Which cap was hit — the message tells the channel which one. */
      scope: "total" | "guild";
      limitUsd: number;
      spentUsd: number;
    };

/**
 * Decides whether another transcription may start.
 *
 * Checked **before** an utterance opens a vendor session, because that is the
 * only moment refusing is free. Mid-flight enforcement would mean abandoning
 * audio the vendor has already billed for — paying the cost and throwing away
 * the transcript.
 *
 * The consequence, stated plainly: the cap can be overshot by at most the
 * utterances already in flight when it is crossed. Bounding the overshoot at
 * zero is not possible without knowing a turn's price before requesting it,
 * which the vendor does not tell us.
 */
export function checkBudget(
  store: UsageStore,
  limits: BudgetLimits,
  guildId: string | null,
  now = new Date()
): BudgetVerdict {
  if (limits.totalUsd && limits.totalUsd > 0) {
    const spent = store.spentThisPeriod(limits.period, undefined, now);
    if (spent >= limits.totalUsd) {
      return { allowed: false, scope: "total", limitUsd: limits.totalUsd, spentUsd: spent };
    }
  }

  if (limits.perGuildUsd && limits.perGuildUsd > 0 && guildId) {
    const spent = store.spentThisPeriod(limits.period, guildId, now);
    if (spent >= limits.perGuildUsd) {
      return { allowed: false, scope: "guild", limitUsd: limits.perGuildUsd, spentUsd: spent };
    }
  }

  return { allowed: true };
}

/** What the channel is told when a cap stops transcription. */
export function budgetMessage(verdict: Extract<BudgetVerdict, { allowed: false }>): string {
  const scope = verdict.scope === "guild" ? "this server's" : "the";
  return (
    `*Transcription is paused: ${scope} budget of ` +
    `$${verdict.limitUsd.toFixed(2)} is used ` +
    `($${verdict.spentUsd.toFixed(4)}).*`
  );
}
