/** Reads an integer env var, falling back when unset or unparseable. */
function intEnv(name: string, fallback: number): number {
  const parsed = parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** Reads a floating-point env var, falling back when unset or unparseable. */
function floatEnv(name: string, fallback: number): number {
  const parsed = parseFloat(process.env[name] ?? "");
  return Number.isFinite(parsed) ? parsed : fallback;
}

const config = {
  // Discord bot token
  DISCORD_TOKEN: process.env.DISCORD_TOKEN || "",

  // Comma-separated vxasr configuration ids, in retry order.
  ASR_CONFIGURATIONS:
    process.env.ASR_CONFIGURATIONS ||
    "openrouter/microsoft/mai-transcribe-1.5",

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

  /**
   * Object storage for per-utterance audio. **Supplying the keys is the
   * switch**: with no bucket and no credentials nothing is recorded, and the
   * bot behaves exactly as before.
   *
   * The reason to keep the audio is a second pass. Each utterance is
   * transcribed on its own, so wording drifts between them; the archive lets
   * the whole meeting be replayed into a multimodal model afterwards, which
   * sees every utterance in one context and can be consistent across them.
   *
   * The audio does not go on the VPS. It is roughly 115 MB per hour of
   * speech, which is a bucket's problem and not a boot disk's.
   */
  RECORDING_BUCKET: process.env.RECORDING_BUCKET || "",
  RECORDING_ENDPOINT: process.env.RECORDING_ENDPOINT || "",
  RECORDING_REGION: process.env.RECORDING_REGION || "auto",
  RECORDING_ACCESS_KEY_ID: process.env.RECORDING_ACCESS_KEY_ID || "",
  RECORDING_SECRET_ACCESS_KEY: process.env.RECORDING_SECRET_ACCESS_KEY || "",
  /** Key prefix, so one bucket can hold more than this bot's recordings. */
  RECORDING_PREFIX: process.env.RECORDING_PREFIX || "recordings",
  /**
   * How long the links in the index stay valid, in seconds. Default 24 hours.
   *
   * The index is posted to a Discord channel, so the links outlive the message
   * only as long as this. Anyone who wants to keep the audio must download it
   * inside the window; after that the objects are still in the bucket, but the
   * links in that CSV no longer open them.
   */
  RECORDING_URL_TTL_SECONDS: intEnv("RECORDING_URL_TTL_SECONDS", 86_400),

  /**
   * How long a session may receive no voice at all before the bot leaves,
   * in milliseconds. 0 disables the sweep.
   *
   * Measured on voice, never on who is in the channel. A radio bot holds the
   * member count above zero indefinitely, and somebody AFK is still a member,
   * so "am I alone?" answers the wrong question. "Has anybody spoken in half
   * an hour?" answers the right one.
   *
   * Leaving also uploads the transcript, so a session everybody walked away
   * from still produces its file rather than losing it.
   */
  IDLE_TIMEOUT_MS: intEnv("IDLE_TIMEOUT_MS", 1_800_000),

  /**
   * Port for the stats HTTP server. 0 disables it.
   *
   * It exists to answer one question before a redeploy: is anybody mid-session
   * right now? Restarting drops every voice connection and abandons whatever
   * is still at the vendor, and from outside the process there is no way to
   * tell an idle bot from a busy one.
   */
  HTTP_PORT: intEnv("HTTP_PORT", 3000),

  /**
   * Address the stats server binds to. Loopback by default: the response names
   * every guild the bot is transcribing for, which is nobody else's business.
   * Set 0.0.0.0 only behind something that controls who can reach it.
   */
  HTTP_HOST: process.env.HTTP_HOST || "127.0.0.1",

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
   * The shortest pause that may end an utterance, in milliseconds, reached as
   * the utterance approaches {@link MAX_UTTERANCE_MS}.
   *
   * The cap on its own is a stopwatch: it cuts at 120.000 s whatever is being
   * said, splitting a word in half and giving both halves to the model with
   * their context missing. So instead of waiting for it, the segmenter grows
   * *impatient* — the silence it demands shrinks from SILENCE_DURATION toward
   * this value as the utterance lengthens, and a long monologue ends at the
   * speaker's next breath rather than mid-syllable.
   *
   * The idea is from dtinth/live-speech, which applies an accelerating decay to
   * a level envelope. This states it directly in milliseconds instead, so the
   * knob still says what it does.
   *
   * The cap stays, as the backstop. Impatience needs a pause to act on, and
   * sound that never dips at all — music, a tone, a noisy room — gives it none.
   * That is the case MAX_UTTERANCE_MS was written for, and it remains the only
   * case that reaches it.
   */
  MIN_SILENCE_DURATION: intEnv("MIN_SILENCE_DURATION", 300),

  /**
   * Shape of the impatience curve: the exponent applied to how far the
   * utterance has run through {@link MAX_UTTERANCE_MS}.
   *
   * Above 1 the curve is flat at first and steep near the end, so ordinary
   * utterances keep the full SILENCE_DURATION and only a long one is hurried.
   * 1 is a straight line; below 1 the patience drops away immediately, which
   * would break up normal speech.
   */
  IMPATIENCE_EASING: floatEnv("IMPATIENCE_EASING", 1.25),

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

export default config;

/** Archiving is configured when a bucket and both credentials are present. */
export function recordingStorageConfig(c: typeof config = config) {
  if (!c.RECORDING_BUCKET || !c.RECORDING_ACCESS_KEY_ID || !c.RECORDING_SECRET_ACCESS_KEY) {
    return null;
  }
  if (!c.RECORDING_ENDPOINT) return null;
  return {
    bucket: c.RECORDING_BUCKET,
    endpoint: c.RECORDING_ENDPOINT,
    region: c.RECORDING_REGION,
    accessKeyId: c.RECORDING_ACCESS_KEY_ID,
    secretAccessKey: c.RECORDING_SECRET_ACCESS_KEY,
  };
}
