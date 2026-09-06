import assert from "node:assert/strict";
import { test } from "node:test";
import { GuildSessions } from "./guild-sessions.ts";

function session(subscription: string) {
  return {
    subscription,
    connection: { destroy: () => {} },
    textChannel: {},
    channelId: "c1",
    startedAt: Date.now(),
  };
}

// The defect this class exists to prevent. Removal used to be by guild id
// alone, from three places, so a late caller could evict a session it did not
// own — leaving it running with nothing pointing at it.
test("a stale owner cannot evict the session that replaced it", () => {
  const sessions = new GuildSessions();
  sessions.set("G", session("S1"));
  sessions.set("G", session("S2")); // S1 has been replaced

  assert.equal(sessions.deleteIf("G", "S1"), false, "S1 no longer owns G");
  assert.equal(sessions.get("G")?.subscription, "S2", "S2 must survive");
  assert.equal(sessions.deleteIf("G", "S2"), true);
  assert.equal(sessions.get("G"), undefined);
});

test("the owner can remove its own entry", () => {
  const sessions = new GuildSessions();
  sessions.set("G", session("S1"));
  assert.equal(sessions.deleteIf("G", "S1"), true);
  assert.equal(sessions.size, 0);
});

test("removing an unknown guild is harmless", () => {
  const sessions = new GuildSessions();
  assert.equal(sessions.deleteIf("nope", "S1"), false);
});

test("a stale owner cannot mark a newer session as closing", () => {
  const sessions = new GuildSessions();
  sessions.set("G", session("S1"));
  sessions.set("G", session("S2"));

  sessions.markClosing("G", "S1");
  assert.notEqual(
    sessions.get("G")?.closing,
    true,
    "S1 must not put S2 into a state that refuses every command"
  );

  sessions.markClosing("G", "S2");
  assert.equal(sessions.get("G")?.closing, true);
});

// The window that let two sessions share one voice connection: the entry was
// deleted before a drain that takes up to 20 s, so the guild looked free.
test("a draining session still occupies its guild", () => {
  const sessions = new GuildSessions();
  sessions.set("G", session("S1"));
  sessions.markClosing("G", "S1");

  assert.equal(sessions.has("G"), true, "a start must still be refused");
  assert.equal(sessions.get("G")?.closing, true, "and told why");
});

test("guilds do not interfere with each other", () => {
  const sessions = new GuildSessions();
  sessions.set("G1", session("S1"));
  sessions.set("G2", session("S2"));

  assert.equal(sessions.deleteIf("G1", "S2"), false, "wrong guild, wrong owner");
  assert.equal(sessions.size, 2);
  assert.equal(sessions.deleteIf("G1", "S1"), true);
  assert.equal(sessions.get("G2")?.subscription, "S2");
});

test("entries() is a snapshot safe to mutate during", () => {
  const sessions = new GuildSessions();
  sessions.set("G1", session("S1"));
  sessions.set("G2", session("S2"));

  for (const [guildId, entry] of sessions.entries()) {
    sessions.deleteIf(guildId, entry.subscription);
  }
  assert.equal(sessions.size, 0);
});
