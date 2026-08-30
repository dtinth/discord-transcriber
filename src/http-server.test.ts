import assert from "node:assert/strict";
import { test } from "node:test";
import { createStatsApp, type BotStats } from "./http-server.ts";

// Requests must use a realistic host. Elysia finds the path with
// `indexOf("/", 11)`, so a short host like `http://x/stats` puts the path
// before that offset and every route misses — a test-only trap, since a real
// request always carries a real host.

function stats(overrides: Partial<BotStats> = {}): BotStats {
  return {
    startedAt: "2026-08-30T00:00:00.000Z",
    uptimeSeconds: 120,
    activeSessions: 0,
    busy: false,
    sessions: [],
    ...overrides,
  };
}

const session = {
  guildId: "g1",
  channelId: "c1",
  startedAt: "2026-08-30T00:01:00.000Z",
  uptimeSeconds: 60,
  speakers: 0,
  pendingUtterances: 0,
  transcribed: 4,
};

test("/healthz answers without touching the stats", async () => {
  let called = false;
  const app = createStatsApp(() => {
    called = true;
    return stats();
  });
  const response = await app.fetch(new Request("http://localhost/healthz"));
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "ok");
  assert.equal(called, false, "a health check must not depend on session state");
});

test("/stats reports the sessions as JSON", async () => {
  const app = createStatsApp(() =>
    stats({ activeSessions: 1, sessions: [session] })
  );
  const response = await app.fetch(new Request("http://localhost/stats"));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.activeSessions, 1);
  assert.equal(body.sessions[0].guildId, "g1");
  assert.equal(body.sessions[0].transcribed, 4);
});

// The endpoint exists to time a redeploy, so this flag is the whole point:
// an open session that nobody is speaking into can be restarted freely.
test("an idle session is not busy", async () => {
  const app = createStatsApp(() =>
    stats({ activeSessions: 1, busy: false, sessions: [session] })
  );
  const body = await (await app.fetch(new Request("http://localhost/stats"))).json();
  assert.equal(body.activeSessions, 1);
  assert.equal(body.busy, false);
});

test("the snapshot is read fresh on every request", async () => {
  let calls = 0;
  const app = createStatsApp(() => {
    calls++;
    return stats({ activeSessions: calls });
  });
  const first = await (await app.fetch(new Request("http://localhost/stats"))).json();
  const second = await (await app.fetch(new Request("http://localhost/stats"))).json();
  assert.equal(first.activeSessions, 1);
  assert.equal(second.activeSessions, 2, "a cached snapshot would be useless");
});

test("an unknown path is a 404, not a crash", async () => {
  const app = createStatsApp(() => stats());
  const response = await app.fetch(new Request("http://localhost/nope"));
  assert.equal(response.status, 404);
});
