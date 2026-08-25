import { DatabaseSync } from "node:sqlite";

/**
 * One row per transcription **attempt**, not per utterance.
 *
 * A failed attempt still spends money — the vendor billed for the audio it
 * processed before it errored — so a budget built from successes alone
 * understates the real spend. That is not hypothetical: the bot's own log line
 * reports the successful attempt's usage only, which is why a retry made an
 * utterance look cheaper than it was.
 */
export interface UsageRow {
  /** Unix milliseconds when the attempt finished. */
  at: number;
  guildId: string | null;
  channelId: string | null;
  /** Discord id of the person who spoke. */
  speakerId: string;
  /** Discord id of whoever started transcription with `!transcribe`. */
  requesterId: string | null;
  configurationId: string;
  attempt: number;
  audioSeconds: number;
  costUsd: number;
  ok: boolean;
  /** Vendor/plumbing error, when `ok` is false. */
  error?: string | null;
}

export type BudgetPeriod = "day" | "month" | "total";

/** Start of the current period, in unix milliseconds. */
export function periodStart(period: BudgetPeriod, now = new Date()): number {
  if (period === "total") return 0;
  const d = new Date(now);
  d.setUTCHours(0, 0, 0, 0);
  if (period === "month") d.setUTCDate(1);
  return d.getTime();
}

/**
 * Append-only record of what the bot spent, and the budget check that reads it.
 *
 * Deliberately synchronous (`node:sqlite`'s `DatabaseSync`): every write is a
 * single small row on the local disk, and making it async would put an `await`
 * between "the vendor billed us" and "the ledger knows", which is exactly the
 * window where a crash loses money silently. It also keeps the budget check a
 * plain function call at the one place that must not proceed on stale numbers.
 */
export class UsageStore {
  private db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    // WAL so a reader (a `!cost` command) never blocks the recording path.
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at INTEGER NOT NULL,
        guild_id TEXT,
        channel_id TEXT,
        speaker_id TEXT NOT NULL,
        requester_id TEXT,
        configuration_id TEXT NOT NULL,
        attempt INTEGER NOT NULL,
        audio_seconds REAL NOT NULL,
        cost_usd REAL NOT NULL,
        ok INTEGER NOT NULL,
        error TEXT
      )
    `);
    // The budget check filters by time, and optionally by guild.
    this.db.exec("CREATE INDEX IF NOT EXISTS usage_at ON usage (at)");
    this.db.exec("CREATE INDEX IF NOT EXISTS usage_guild_at ON usage (guild_id, at)");
  }

  record(row: UsageRow): void {
    this.db
      .prepare(
        `INSERT INTO usage
           (at, guild_id, channel_id, speaker_id, requester_id,
            configuration_id, attempt, audio_seconds, cost_usd, ok, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        row.at,
        row.guildId,
        row.channelId,
        row.speakerId,
        row.requesterId,
        row.configurationId,
        row.attempt,
        row.audioSeconds,
        row.costUsd,
        row.ok ? 1 : 0,
        row.error ?? null
      );
  }

  /** Total spent since `since`, optionally for one guild. */
  totalSince(since: number, guildId?: string): number {
    const row = guildId
      ? this.db
          .prepare(
            "SELECT COALESCE(SUM(cost_usd), 0) AS total FROM usage WHERE at >= ? AND guild_id = ?"
          )
          .get(since, guildId)
      : this.db
          .prepare("SELECT COALESCE(SUM(cost_usd), 0) AS total FROM usage WHERE at >= ?")
          .get(since);
    return Number((row as { total: number }).total);
  }

  /** Spend for the current period — what the budget is measured against. */
  spentThisPeriod(period: BudgetPeriod, guildId?: string, now = new Date()): number {
    return this.totalSince(periodStart(period, now), guildId);
  }

  /** A short breakdown for a `!cost` reply. */
  summary(period: BudgetPeriod, guildId?: string, now = new Date()) {
    const since = periodStart(period, now);
    const where = guildId ? "WHERE at >= ? AND guild_id = ?" : "WHERE at >= ?";
    const args = guildId ? [since, guildId] : [since];
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(cost_usd), 0) AS total,
                COALESCE(SUM(audio_seconds), 0) AS seconds,
                COUNT(*) AS attempts,
                COALESCE(SUM(1 - ok), 0) AS failed
         FROM usage ${where}`
      )
      .get(...args) as {
      total: number;
      seconds: number;
      attempts: number;
      failed: number;
    };
    return {
      totalUsd: Number(row.total),
      audioSeconds: Number(row.seconds),
      attempts: Number(row.attempts),
      failedAttempts: Number(row.failed),
    };
  }

  close(): void {
    this.db.close();
  }
}
