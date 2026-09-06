/**
 * Rebuild a lost session transcript from the channel's messages.
 *
 * Usage:
 *   deno task recover <channelId> [--after <messageId>] [--out file.csv]
 *
 * Reads only. It never joins a voice channel, never sends a message, and does
 * not touch the running bot — safe to run against production while the bot is
 * live. It needs DISCORD_TOKEN and nothing else; the messages it reads were
 * written by the bot itself, so Discord returns their content regardless of
 * which intents the application holds.
 */
import {
  rowsFromMessages,
  rowsToCsv,
  type RawMessage,
} from "../src/recover-transcript.ts";

const API = "https://discord.com/api/v10";

function parseArgs(argv: string[]) {
  const positional: string[] = [];
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) flags.set(argv[i].slice(2), argv[++i] ?? "");
    else positional.push(argv[i]);
  }
  return { channelId: positional[0], flags };
}

async function api(path: string, token: string) {
  const response = await fetch(`${API}${path}`, {
    headers: { Authorization: `Bot ${token}` },
  });
  if (response.status === 429) {
    const retry = Number(response.headers.get("retry-after") ?? "1");
    console.error(`Rate limited; waiting ${retry}s`);
    await new Promise((r) => setTimeout(r, retry * 1000));
    return api(path, token);
  }
  if (!response.ok) {
    throw new Error(`${path} -> ${response.status} ${await response.text()}`);
  }
  return response.json();
}

const { channelId, flags } = parseArgs(Deno.args);
if (!channelId) {
  console.error(
    "Usage: deno task recover <channelId> [--after <messageId>] [--out file.csv]"
  );
  Deno.exit(1);
}
const token = Deno.env.get("DISCORD_TOKEN");
if (!token) {
  console.error("DISCORD_TOKEN is required");
  Deno.exit(1);
}

const me = await api("/users/@me", token);
console.error(`Reading as ${me.username} (${me.id})`);

// Page backwards from newest, which is the only direction Discord pages, and
// stop at --after so a recovery can be scoped to one session.
const after = flags.get("after");
const collected: RawMessage[] = [];
let before: string | undefined;
for (;;) {
  const query = new URLSearchParams({ limit: "100" });
  if (before) query.set("before", before);
  const batch: RawMessage[] = await api(
    `/channels/${channelId}/messages?${query}`,
    token
  );
  if (batch.length === 0) break;
  for (const message of batch) {
    if (after && BigInt(message.id) <= BigInt(after)) continue;
    collected.push(message);
  }
  before = batch[batch.length - 1].id;
  console.error(`  fetched ${collected.length} messages…`);
  if (after && BigInt(before) <= BigInt(after)) break;
  if (batch.length < 100) break;
}

const rows = rowsFromMessages(collected, me.id);
const csv = rowsToCsv(rows);
const out = flags.get("out");
if (out) {
  Deno.writeTextFileSync(out, csv);
  console.error(`Wrote ${rows.length} utterances to ${out}`);
} else {
  console.log(csv);
  console.error(`Recovered ${rows.length} utterances`);
}
