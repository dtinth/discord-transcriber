/**
 * The per-guild registry of live transcription sessions.
 *
 * This was a bare `Map` in `index.ts`, and three separate places removed
 * entries from it by key alone — the stop command, the idle sweep, and the
 * voice connection's `Disconnected` listener. Removing by key is wrong the
 * moment a guild can hold a *different* session than the one being torn down,
 * because the remover then evicts a session it does not own, leaving that
 * session running with nothing pointing at it: no command can reach it, the
 * idle sweep cannot see it, and `/stats` does not count it.
 *
 * Every removal here is therefore identity-checked against the subscription
 * that owns the entry.
 */
export interface GuildSession<TConnection = unknown, TChannel = unknown> {
  subscription: string;
  connection: TConnection;
  textChannel: TChannel;
  channelId: string | null;
  startedAt: number;
  /**
   * Set while the session is draining.
   *
   * The drain waits up to 20 s for the vendor, and the entry used to be
   * deleted *before* that wait. A `/transcriber start` arriving in the gap saw
   * an empty guild and opened a second session on the same voice connection —
   * which the finishing stop then destroyed underneath it. The entry now stays
   * until the drain is over, and this flag says why a start is being refused.
   */
  closing?: boolean;
}

export class GuildSessions<TConnection = unknown, TChannel = unknown> {
  private sessions = new Map<string, GuildSession<TConnection, TChannel>>();

  get size(): number {
    return this.sessions.size;
  }

  get(guildId: string): GuildSession<TConnection, TChannel> | undefined {
    return this.sessions.get(guildId);
  }

  has(guildId: string): boolean {
    return this.sessions.has(guildId);
  }

  set(guildId: string, session: GuildSession<TConnection, TChannel>): void {
    this.sessions.set(guildId, session);
  }

  entries(): Array<[string, GuildSession<TConnection, TChannel>]> {
    return [...this.sessions.entries()];
  }

  /** Mark the guild's session as draining, so a start is refused meanwhile. */
  markClosing(guildId: string, subscription: string): void {
    const session = this.sessions.get(guildId);
    if (session?.subscription === subscription) session.closing = true;
  }

  /**
   * Remove the guild's session **only if** `subscription` still owns it.
   *
   * Returns whether anything was removed. A stale caller — an old session's
   * `Disconnected` listener, a drain that finished after the guild moved on —
   * gets `false` and leaves the current session alone.
   */
  deleteIf(guildId: string, subscription: string): boolean {
    const session = this.sessions.get(guildId);
    if (!session || session.subscription !== subscription) return false;
    this.sessions.delete(guildId);
    return true;
  }
}
