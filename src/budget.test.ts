import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { budgetMessage, checkBudget } from "./budget.ts";
import { UsageStore, type UsageRow } from "./usage-store.ts";

function store(): UsageStore {
  return new UsageStore(join(mkdtempSync(join(tmpdir(), "budget-")), "usage.db"));
}

function spend(s: UsageStore, costUsd: number, guildId = "g1", at = Date.now()) {
  const row: UsageRow = {
    at,
    guildId,
    channelId: "c1",
    speakerId: "s1",
    requesterId: "r1",
    configurationId: "qwen-omni/model",
    attempt: 1,
    audioSeconds: 1,
    costUsd,
    ok: true,
  };
  s.record(row);
}

test("allows spending below the cap and refuses at or above it", () => {
  const s = store();
  const limits = { totalUsd: 1, period: "month" as const };

  assert.deepEqual(checkBudget(s, limits, "g1"), { allowed: true });

  spend(s, 0.99);
  assert.equal(checkBudget(s, limits, "g1").allowed, true);

  spend(s, 0.01); // exactly at the cap
  const verdict = checkBudget(s, limits, "g1");
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.allowed === false && verdict.scope, "total");
  s.close();
});

test("no cap configured means never blocked", () => {
  const s = store();
  spend(s, 1000);
  assert.deepEqual(checkBudget(s, { period: "month" }, "g1"), { allowed: true });
  assert.deepEqual(checkBudget(s, { totalUsd: 0, period: "month" }, "g1"), { allowed: true });
  s.close();
});

// One noisy server must not be able to consume everyone else's budget.
test("a per-guild cap stops only the guild that hit it", () => {
  const s = store();
  const limits = { totalUsd: 100, perGuildUsd: 1, period: "month" as const };

  spend(s, 1.5, "g1");
  const blocked = checkBudget(s, limits, "g1");
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.allowed === false && blocked.scope, "guild");

  assert.deepEqual(checkBudget(s, limits, "g2"), { allowed: true });
  s.close();
});

test("the global cap outranks a guild that is still under its own", () => {
  const s = store();
  const limits = { totalUsd: 2, perGuildUsd: 100, period: "month" as const };
  spend(s, 1.5, "g1");
  spend(s, 0.6, "g2");

  const verdict = checkBudget(s, limits, "g2");
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.allowed === false && verdict.scope, "total");
  s.close();
});

// A monthly budget that never resets is a bot that stops for ever.
test("a new period releases the block by itself", () => {
  const s = store();
  const limits = { totalUsd: 1, period: "month" as const };
  spend(s, 5, "g1", new Date("2026-07-10T00:00:00Z").getTime());

  assert.equal(checkBudget(s, limits, "g1", new Date("2026-07-20T00:00:00Z")).allowed, false);
  assert.equal(checkBudget(s, limits, "g1", new Date("2026-08-01T00:00:00Z")).allowed, true);
  s.close();
});

test("the pause message names the cap that was hit", () => {
  const total = budgetMessage({ allowed: false, scope: "total", limitUsd: 10, spentUsd: 10.5 });
  assert.match(total, /the budget of \$10\.00/);

  const guild = budgetMessage({ allowed: false, scope: "guild", limitUsd: 2, spentUsd: 2.25 });
  assert.match(guild, /this server's budget/);
});
