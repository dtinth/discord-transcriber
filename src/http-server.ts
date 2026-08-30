import { Elysia } from "elysia";
import logger from "./logger.ts";

/** One transcription session, as the stats endpoint reports it. */
export interface SessionStats {
  guildId: string | null;
  channelId: string | null;
  startedAt: string;
  uptimeSeconds: number;
  /** Speakers whose audio is being segmented right now. */
  speakers: number;
  /** Utterances sent to the vendor and still waiting for a transcript. */
  pendingUtterances: number;
  /** Utterances already transcribed in this session. */
  transcribed: number;
}

export interface BotStats {
  startedAt: string;
  uptimeSeconds: number;
  activeSessions: number;
  /**
   * Whether a restart would lose anything right now.
   *
   * This is the number the endpoint exists for. A session with nobody speaking
   * and nothing at the vendor survives a restart with no loss worse than the
   * bot leaving the channel; one with either is holding audio that a restart
   * throws away. Reading `activeSessions` alone would hold up a redeploy for
   * sessions that are merely open, which is most of them.
   */
  busy: boolean;
  sessions: SessionStats[];
}

/**
 * The stats app.
 *
 * Built separately from the listener so tests can drive `app.fetch` directly,
 * with no port and no process-wide state.
 */
export function createStatsApp(getStats: () => BotStats) {
  return new Elysia()
    .get("/healthz", () => "ok")
    .get("/stats", () => getStats());
}

/**
 * Serve the stats app.
 *
 * Deno rather than Elysia's own `listen`: on Deno, Elysia loads its
 * WebStandard adapter, whose `listen` throws outright — the supported path is
 * to hand `app.fetch` to the runtime's own server.
 */
export function startStatsServer(
  port: number,
  hostname: string,
  getStats: () => BotStats
): Deno.HttpServer {
  const app = createStatsApp(getStats);
  const server = Deno.serve(
    {
      port,
      hostname,
      onListen: ({ hostname, port }) =>
        logger.info(`Stats server listening on http://${hostname}:${port}`),
      // A failed request must never take the bot down with it.
      onError: (error) => {
        logger.error("Stats server error:", error);
        return new Response("internal error", { status: 500 });
      },
    },
    app.fetch
  );
  return server;
}
