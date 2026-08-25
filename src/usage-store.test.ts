import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { UsageStore, periodStart, type UsageRow } from "./usage-store.ts";

function store(): UsageStore {
  return new UsageStore(join(mkdtempSync(join(tmpdir(), "usage-")), "usage.db"));
}

function row(overrides: Partial<UsageRow> = {}): UsageRow {
  return {
    at: Date.now(),
    guildId: "g1",
    channelId: "c1",
    speakerId: "s1",
    requesterId: "r1",
    configurationId: "qwen-omni/model",
    attempt: 1,
    audioSeconds: 5,
    costUsd: 0.001,
    ok: true,
    ...overrides,
  };
}

test("records attempts and totals their cost", () => {
  const s = store();
  s.record(row({ costUsd: 0.001 }));
  s.record(row({ costUsd: 0.002 }));
  assert.equal(Number(s.totalSince(0).toFixed(6)), 0.003);
  s.close();
});

// The budget must count money the vendor took, not transcripts we received.
test("a failed attempt still counts against the budget", () => {
  const s = store();
  s.record(row({ ok: false, costUsd: 0.004, attempt: 1, error: "model repeat output" }));
  s.record(row({ ok: true, costUsd: 0.001, attempt: 2 }));

  assert.equal(Number(s.totalSince(0).toFixed(6)), 0.005);
  const summary = s.summary("total");
  assert.equal(summary.attempts, 2);
  assert.equal(summary.failedAttempts, 1);
  s.close();
});

test("totals are scoped per guild", () => {
  const s = store();
  s.record(row({ guildId: "g1", costUsd: 0.01 }));
  s.record(row({ guildId: "g2", costUsd: 0.02 }));

  assert.equal(Number(s.totalSince(0, "g1").toFixed(6)), 0.01);
  assert.equal(Number(s.totalSince(0, "g2").toFixed(6)), 0.02);
  assert.equal(Number(s.totalSince(0).toFixed(6)), 0.03);
  s.close();
});

test("spend older than the period is excluded", () => {
  const s = store();
  const now = new Date("2026-08-15T12:00:00Z");
  // Last month, and earlier today.
  s.record(row({ at: new Date("2026-07-20T12:00:00Z").getTime(), costUsd: 5 }));
  s.record(row({ at: new Date("2026-08-15T01:00:00Z").getTime(), costUsd: 0.5 }));

  assert.equal(s.spentThisPeriod("month", undefined, now), 0.5);
  assert.equal(s.spentThisPeriod("day", undefined, now), 0.5);
  assert.equal(s.spentThisPeriod("total", undefined, now), 5.5);
  s.close();
});

test("period boundaries are UTC day and month starts", () => {
  const now = new Date("2026-08-15T12:34:56Z");
  assert.equal(new Date(periodStart("day", now)).toISOString(), "2026-08-15T00:00:00.000Z");
  assert.equal(new Date(periodStart("month", now)).toISOString(), "2026-08-01T00:00:00.000Z");
  assert.equal(periodStart("total", now), 0);
});

test("survives reopening the same file", () => {
  const dir = mkdtempSync(join(tmpdir(), "usage-"));
  const path = join(dir, "usage.db");
  const a = new UsageStore(path);
  a.record(row({ costUsd: 0.007 }));
  a.close();

  const b = new UsageStore(path);
  assert.equal(Number(b.totalSince(0).toFixed(6)), 0.007);
  b.close();
});
