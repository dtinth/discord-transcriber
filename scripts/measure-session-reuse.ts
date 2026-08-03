/**
 * Measures what qwen-omni session reuse (`clientId`, vxasr 0.1.0-next.8) costs
 * and saves for this bot.
 *
 * Sends the same utterance repeatedly against the real API — once with a shared
 * clientId (the vendor connection is reused) and once without (a fresh socket
 * per turn) — and reports latency, vendor-reported cost, and the transcripts.
 *
 * **This spends money.** It makes 12 real DashScope calls (a few tenths of a
 * cent). Run it only to re-check the decision recorded in the issue thread:
 *
 *   node --env-file=.env --experimental-transform-types scripts/measure-session-reuse.ts
 *
 * The measured result (2026-08-03) was that reuse is a net loss here: input
 * audio tokens accumulate linearly across reused turns (21, 42, 63, 84, …)
 * because the vendor re-processes prior turns as context, so six turns cost
 * ~87% more and were no faster. The bot therefore does not pass a clientId.
 *
 * Note the harness must NOT call `session.close()` on a clean end — `settle()`
 * runs immediately after `onEnd` and offers the connection to the pool, so
 * closing there terminates the socket first and silently disables reuse.
 */
import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import { createDefaultConfigurationCatalogue } from "vxasr";
import { readPcm } from "vxasr/audio";

const CONFIG_ID = "qwen-omni/qwen3.5-omni-flash-realtime-2026-03-15";
const TURNS = 6;
const CHUNK = 3200; // 100 ms

const catalogue = createDefaultConfigurationCatalogue();
const resolution = catalogue.resolve(process.env, CONFIG_ID);
if (!resolution.ok) throw new Error(resolution.error.message);
const provider = resolution.provider;

const { pcm } = readPcm(readFileSync("testdata/speech.wav"));
// One "utterance": the first sentence of the fixture, ~2.9 s.
const utterance = pcm.subarray(0, Math.floor(2.9 * 32000));

interface TurnResult {
  index: number;
  ms: number;
  cost: number;
  audioTokens: number;
  text: string;
  reused: boolean;
}

function runTurn(index: number, clientId?: string): Promise<TurnResult> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    let text = "";
    let cost = 0;
    let audioTokens = 0;

    const session = provider.createSession({
      clientId,
      onFinal: (value) => (text = value),
      onUsage: (records) => {
        for (const record of records) {
          cost += record.unitPrice * record.quantity;
          if (record.sku.endsWith("input-audio-tokens")) audioTokens = record.quantity;
        }
      },
      onEnd: () => {
        // Deliberately NOT session.close(): `settle()` runs right after this
        // callback and offers the connection to the pool, and close() would
        // terminate the socket before that could happen. Closing on a clean end
        // silently disables reuse.
        resolve({
          index,
          ms: Date.now() - started,
          cost,
          audioTokens,
          text: text.trim(),
          reused: false,
        });
      },
      onError: (error) => {
        session.close();
        reject(error);
      },
    });

    // Realtime pacing, as the bot does for a live speaker.
    let offset = 0;
    const timer = setInterval(() => {
      if (offset >= utterance.length) {
        clearInterval(timer);
        session.finish();
        return;
      }
      session.sendAudio(Buffer.from(utterance.subarray(offset, offset + CHUNK)));
      offset += CHUNK;
    }, 100);
  });
}

async function runSeries(label: string, clientId?: string): Promise<TurnResult[]> {
  const results: TurnResult[] = [];
  for (let i = 1; i <= TURNS; i++) {
    const result = await runTurn(i, clientId);
    results.push(result);
    console.log(
      `  ${label} turn ${i}: ${result.ms} ms, $${result.cost.toFixed(6)}, ` +
        `${result.audioTokens} audio tokens`
    );
    // A short gap, well inside the 30 s linger window.
    await new Promise((r) => setTimeout(r, 1500));
  }
  return results;
}

function summarize(label: string, results: TurnResult[]) {
  const totalCost = results.reduce((n, r) => n + r.cost, 0);
  const totalMs = results.reduce((n, r) => n + r.ms, 0);
  const tokens = results.reduce((n, r) => n + r.audioTokens, 0);
  console.log(
    `${label}: total $${totalCost.toFixed(6)}, ` +
      `mean ${Math.round(totalMs / results.length)} ms, ${tokens} audio tokens`
  );
  return { totalCost, meanMs: totalMs / results.length, tokens };
}

console.log(`${TURNS} turns of ${(utterance.length / 32000).toFixed(1)}s audio each\n`);

console.log("WITHOUT reuse (a fresh connection per turn):");
const without = await runSeries("no-reuse");
console.log("\nWITH reuse (one clientId for every turn):");
const with_ = await runSeries("reuse", `measure-${process.pid}`);

console.log("\n--- summary ---");
const a = summarize("without reuse", without);
const b = summarize("with reuse   ", with_);
console.log(
  `\ncost:    ${((b.totalCost / a.totalCost - 1) * 100).toFixed(1)}% ` +
    `(${b.totalCost > a.totalCost ? "more expensive" : "cheaper"} with reuse)`
);
console.log(
  `latency: ${(b.meanMs - a.meanMs).toFixed(0)} ms per turn ` +
    `(${b.meanMs < a.meanMs ? "faster" : "slower"} with reuse)`
);
console.log(`audio tokens: ${a.tokens} -> ${b.tokens}`);

console.log("\n--- per-turn audio tokens (does context accumulate?) ---");
console.log("without:", without.map((r) => r.audioTokens).join(", "));
console.log("with:   ", with_.map((r) => r.audioTokens).join(", "));

console.log("\n--- transcripts ---");
without.forEach((r, i) => {
  const other = with_[i];
  const same = r.text === other.text ? "same" : "DIFFERENT";
  console.log(`turn ${i + 1} [${same}]`);
  console.log(`  without: ${r.text}`);
  console.log(`  with:    ${other.text}`);
});
process.exit(0);
