import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildUsageReply,
  formatAudioDuration,
  START_SUBCOMMAND,
  STOP_SUBCOMMAND,
  transcriberCommand,
  USAGE_SUBCOMMAND,
} from "./commands.ts";

test("the command declares exactly the three subcommands the handler serves", () => {
  const json = transcriberCommand.toJSON();
  assert.equal(json.name, "transcriber");
  const names = (json.options ?? []).map((option) => option.name);
  assert.deepEqual(names.sort(), [
    START_SUBCOMMAND,
    STOP_SUBCOMMAND,
    USAGE_SUBCOMMAND,
  ].sort());
});

// Discord rejects the whole registration if any name or description is
// invalid, and the only symptom is a command that never appears.
test("every name and description satisfies Discord's rules", () => {
  const json = transcriberCommand.toJSON();
  const entries = [json, ...(json.options ?? [])] as Array<{
    name: string;
    description: string;
  }>;
  for (const entry of entries) {
    assert.match(entry.name, /^[a-z0-9_-]{1,32}$/, `bad name: ${entry.name}`);
    assert.ok(entry.description.length > 0, `empty description: ${entry.name}`);
    assert.ok(
      entry.description.length <= 100,
      `description too long: ${entry.name}`
    );
  }
});

test("formatAudioDuration stays readable as the numbers grow", () => {
  assert.equal(formatAudioDuration(0), "0s");
  assert.equal(formatAudioDuration(45.4), "45s");
  // Rounding up past the minute must read as a minute, not as "60s".
  assert.equal(formatAudioDuration(59.6), "1m 0s");
  assert.equal(formatAudioDuration(60), "1m 0s");
  assert.equal(formatAudioDuration(125), "2m 5s");
  assert.equal(formatAudioDuration(3600), "1h 0m");
  assert.equal(formatAudioDuration(7830), "2h 10m");
});

// The whole point of the reply: audio, never money. The ledger still records
// the cost per attempt, and the budget still reads it — but a channel is told
// what it transcribed, not what the operator paid.
test("the usage reply reports audio and never a price", () => {
  const reply = buildUsageReply(
    { audioSeconds: 3725, attempts: 40 },
    "month"
  );
  assert.match(reply, /1h 2m/);
  assert.match(reply, /this month/);
  assert.ok(!reply.includes("$"), "the reply must not mention money");
  assert.ok(!/cost|usd|spent/i.test(reply), "the reply must not mention cost");
});

test("an idle server is told so, rather than shown a zero", () => {
  const reply = buildUsageReply({ audioSeconds: 0, attempts: 0 }, "day");
  assert.match(reply, /no audio/);
  assert.match(reply, /this day/);
});

test("the total period reads as a sentence, not as 'this total'", () => {
  const reply = buildUsageReply({ audioSeconds: 90, attempts: 1 }, "total");
  assert.match(reply, /in total/);
  assert.ok(!reply.includes("this total"));
});
