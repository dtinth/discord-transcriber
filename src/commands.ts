import { SlashCommandBuilder } from "discord.js";
import type { BudgetPeriod } from "./usage-store.ts";

/**
 * The bot's only command, as three subcommands.
 *
 * Slash commands replaced the `!` prefix so the bot no longer needs the
 * MESSAGE CONTENT privileged intent. That intent was read by exactly two
 * lines, both parsing a command name — and below 100 servers it is a checkbox,
 * but at 100 servers it becomes a Discord review of the application. "So the
 * bot can read `!transcribe`" is a poor case to make when the platform has a
 * mechanism built for it.
 */
export const transcriberCommand = new SlashCommandBuilder()
  .setName("transcriber")
  .setDescription("Transcribe the voice channel you are in")
  .addSubcommand((sub) =>
    sub
      .setName("start")
      .setDescription("Start transcribing the voice channel you are in")
  )
  .addSubcommand((sub) =>
    sub
      .setName("stop")
      .setDescription("Stop transcribing and upload the transcript")
  )
  .addSubcommand((sub) =>
    sub
      .setName("usage")
      .setDescription("How much audio this server has transcribed")
  );

/** Subcommand names, so the handler and the definition cannot drift apart. */
export const START_SUBCOMMAND = "start";
export const STOP_SUBCOMMAND = "stop";
export const USAGE_SUBCOMMAND = "usage";

/**
 * Human-readable audio duration. Seconds alone stop being informative in the
 * thousands, which is where a busy server lands within a single meeting.
 */
export function formatAudioDuration(seconds: number): string {
  const whole = Math.round(seconds);
  if (whole < 60) return `${whole}s`;

  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const rest = whole % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m ${rest}s`;
}

/** How the period reads in a sentence. */
function periodLabel(period: BudgetPeriod): string {
  if (period === "total") return "in total";
  return `this ${period}`;
}

/**
 * The `/transcriber usage` reply.
 *
 * Deliberately audio only — no money. What a server can act on is how much it
 * has transcribed; the price per second is an operator's concern, is a
 * different number for every configured model, and telling a channel what the
 * operator is paying invites a conversation nobody asked for. The cost is
 * still recorded per attempt in the ledger, and the budget still reads it.
 */
export function buildUsageReply(
  summary: { audioSeconds: number; attempts: number },
  period: BudgetPeriod
): string {
  if (summary.audioSeconds === 0) {
    return `This server has transcribed no audio ${periodLabel(period)}.`;
  }
  return (
    `This server has transcribed **${formatAudioDuration(summary.audioSeconds)}** ` +
    `of audio ${periodLabel(period)}.`
  );
}
