/** Reads an integer env var, falling back when unset or unparseable. */
function intEnv(name: string, fallback: number): number {
  const parsed = parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export default {
  // Discord bot token
  DISCORD_TOKEN: process.env.DISCORD_TOKEN || "",

  // Comma-separated vxasr configuration ids, in retry order.
  ASR_CONFIGURATIONS:
    process.env.ASR_CONFIGURATIONS ||
    "qwen-omni/qwen3.5-omni-flash-realtime-2026-03-15",

  /**
   * Reuse a speaker's vendor connection for their next utterance, so the model
   * keeps the context of what they just said. Short sentences transcribe better
   * with it, but the vendor re-processes prior turns as context, so it costs
   * more — measured at +87% over six turns, see
   * `scripts/measure-session-reuse.ts`. Set to 0 to go back to a fresh
   * connection per utterance.
   */
  ASR_SESSION_REUSE: process.env.ASR_SESSION_REUSE !== "0",

  /** SQLite file holding the usage ledger. */
  USAGE_DB: process.env.USAGE_DB || "usage.db",

  /**
   * Spend cap across every guild, in USD, for {@link BUDGET_PERIOD}. 0 (the
   * default) means no cap — the bot never refuses on cost.
   */
  BUDGET_USD: Number(process.env.BUDGET_USD ?? 0),

  /**
   * Optional per-guild cap, so one server cannot consume the whole budget.
   * 0 disables it. Only meaningful when the bot serves more than one guild.
   */
  BUDGET_PER_GUILD_USD: Number(process.env.BUDGET_PER_GUILD_USD ?? 0),

  /** Window the caps are measured over: `day`, `month`, or `total`. */
  BUDGET_PERIOD: (process.env.BUDGET_PERIOD || "month") as
    | "day"
    | "month"
    | "total",

  // Discord command prefix
  PREFIX: "!",

  // Command that reports what has been spent this period
  COST_COMMAND: "cost",

  // Command for starting transcription
  START_COMMAND: "transcribe",

  // Command for stopping transcription
  STOP_COMMAND: "stop",

  // Logging level (1=error, 2=warn, 3=log, 4=info, 5=debug)
  LOG_LEVEL: intEnv("LOG_LEVEL", 4),

  // Voice detection settings
  ACTIVATION_THRESHOLD: 0.5,   // Confidence threshold to start utterance
  DEACTIVATION_THRESHOLD: 0.3, // Lower threshold to maintain active utterance

  /**
   * Silence *within the audio* that ends an utterance, in milliseconds.
   *
   * Raising it joins short sentences into one utterance, which gives the model
   * more context in a single turn — the cheap alternative to session reuse. It
   * is bounded in practice by {@link RECEIVER_SILENCE_MS}: once Discord stops
   * sending the stream, the utterance is finalized regardless, so raising this
   * past that value has little effect on its own.
   */
  SILENCE_DURATION: intEnv("SILENCE_DURATION", 1500),

  /**
   * Longest a single utterance may run, in milliseconds, before it is split and
   * a new one continues.
   *
   * Silence ends an utterance, so without a cap anything that never pauses —
   * music, a television, a noisy room — grows one utterance without limit: an
   * ever-growing buffer, one enormous vendor turn, and a Discord message that
   * shows nothing for as long as it lasts. Splitting keeps every second of
   * audio; it only decides where one message ends and the next begins.
   */
  MAX_UTTERANCE_MS: intEnv("MAX_UTTERANCE_MS", 120_000),

  /**
   * Wall-clock silence, in milliseconds, that means audio stopped *arriving* —
   * a mute, a disconnect, a stalled stream. Kept above
   * {@link SILENCE_DURATION} so that whenever packets are actually flowing the
   * audio clock decides where an utterance ends; this only takes over when
   * there is no audio left to measure.
   */
  STALL_TIMEOUT_MS: intEnv("STALL_TIMEOUT_MS", 2000),

  /**
   * How long Discord waits, in milliseconds, before it ends a speaker's audio
   * stream. This is the ceiling on {@link SILENCE_DURATION}: once the stream
   * ends, the utterance is finalized whatever the VAD thinks, so it is kept a
   * second above it rather than pinned to Discord's 2000 ms default.
   */
  RECEIVER_SILENCE_MS: intEnv("RECEIVER_SILENCE_MS", 2500),
};
