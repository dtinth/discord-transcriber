import { AttachmentBuilder } from "discord.js";
import type { Message, TextBasedChannel } from "discord.js";
import { Buffer } from "node:buffer";
import logger from "./logger.ts";
import { realTimers, type Timers } from "./timers.ts";

/** An edit fires once the partial text has been stable this long… */
export const DEBOUNCE_MS = 500;

/**
 * …but never sooner than this after the previous edit, and never later than
 * this after text first became pending. The debounce alone would starve a
 * provider that streams continuously (Qwen emits a partial every ~100 ms),
 * and would collapse a provider that rapid-fires everything at the end
 * (Qwen Omni) into exactly one edit — which is the point.
 */
export const THROTTLE_MS = 1500;

/**
 * Owns one utterance's Discord message: the placeholder, throttled partial
 * updates, and the terminal states (final text, delete-on-no-speech, error
 * with the audio attached).
 *
 * All Discord calls are serialized through one promise chain, so a slow edit
 * can never land after a later one — or after the delete.
 */
export class ThrottledMessageUpdater {
  private chain: Promise<Message | null>;
  private pendingText: string | null = null;
  private firstPendingAt = 0;
  private lastTextAt = 0;
  private lastFlushAt = -Infinity;
  private timerHandle: unknown;
  private done = false;

  constructor(
    private userId: string,
    channel: TextBasedChannel,
    private timers: Timers = realTimers
  ) {
    this.chain =
      "send" in channel
        ? channel.send(this.render("*Listening...*")).catch((error) => {
            logger.error("Error creating placeholder message:", error);
            return null;
          })
        : Promise.resolve(null);
  }

  /** Show live partial text, subject to debounce + throttle. */
  setPartial(text: string): void {
    if (this.done) return;
    const now = this.timers.now();
    if (this.pendingText === null) this.firstPendingAt = now;
    this.pendingText = text;
    this.lastTextAt = now;
    this.armTimer();
  }

  /**
   * Show a transient status (e.g. "Transcribing…", "Retrying…"). Skipped when
   * partial text is already on screen or pending — text beats status.
   */
  setStatus(status: string): void {
    if (this.done || this.pendingText !== null) return;
    this.edit(this.render(`*${status}*`));
  }

  /** Show the final transcript immediately, bypassing debounce and throttle. */
  finalize(text: string): Promise<void> {
    return this.terminal(() => this.edit(this.render(text)));
  }

  /** No speech was detected: delete the message rather than say so. */
  noSpeech(): Promise<void> {
    return this.terminal(() =>
      this.withMessage(async (message) => {
        await message.delete();
        logger.debug(`Deleted message for user ${this.userId} (no speech)`);
        return null;
      })
    );
  }

  /** Transcription failed for good. Attach the audio so it is not lost. */
  fail(wav?: Uint8Array): Promise<void> {
    return this.terminal(() =>
      this.withMessage(async (message) => {
        const files = wav
          ? [new AttachmentBuilder(Buffer.from(wav), { name: "audio.wav" })]
          : [];
        return message.edit({
          content: this.render("*Error transcribing audio*"),
          files,
        });
      })
    );
  }

  private render(body: string): string {
    return `<@${this.userId}>: ${body}`;
  }

  private terminal(fn: () => void): Promise<void> {
    this.done = true;
    this.pendingText = null;
    if (this.timerHandle !== undefined) {
      this.timers.clearTimeout(this.timerHandle);
      this.timerHandle = undefined;
    }
    fn();
    return this.chain.then(() => undefined);
  }

  private armTimer(): void {
    if (this.timerHandle !== undefined) return;
    const now = this.timers.now();
    const fireAt = Math.max(
      this.lastFlushAt + THROTTLE_MS,
      Math.min(this.lastTextAt + DEBOUNCE_MS, this.firstPendingAt + THROTTLE_MS)
    );
    this.timerHandle = this.timers.setTimeout(
      () => this.onTimer(),
      Math.max(0, fireAt - now)
    );
  }

  private onTimer(): void {
    this.timerHandle = undefined;
    if (this.done || this.pendingText === null) return;

    const now = this.timers.now();
    const fireAt = Math.max(
      this.lastFlushAt + THROTTLE_MS,
      Math.min(this.lastTextAt + DEBOUNCE_MS, this.firstPendingAt + THROTTLE_MS)
    );
    if (now < fireAt) {
      // More text arrived since the timer was set; wait out the new deadline.
      this.armTimer();
      return;
    }

    const text = this.pendingText;
    this.pendingText = null;
    this.lastFlushAt = now;
    this.edit(this.render(`${text} …`));
  }

  private edit(content: string): void {
    this.withMessage(async (message) => message.edit(content));
  }

  /** Queue one Discord operation onto the serial chain. */
  private withMessage(
    fn: (message: Message) => Promise<Message | null>
  ): Promise<void> {
    this.chain = this.chain.then(async (message) => {
      if (!message) return null;
      try {
        return await fn(message);
      } catch (error) {
        logger.error("Error updating Discord message:", error);
        return message;
      }
    });
    return this.chain.then(() => undefined);
  }
}
