# Discord Transcriber Bot Development Guide

## Commands

**This project runs on Deno only.** There is no `package.json` and no Node path.

- `deno install --frozen --allow-scripts=npm:onnxruntime-node` - Install dependencies. `--allow-scripts` is required: the VAD's native binary is fetched by a postinstall, and without it the bot starts and detects no speech
- `deno task dev` - Start with hot reloading
- `deno task start` - Start the application
- `deno task test` - Run unit tests (`node:test` via Deno; hermetic — no network, no credentials)
- `deno task check` - Type check
- `deno task verify` - Prove this checkout can actually decode audio and load the VAD (also run in the Docker build and CI)

## Project Structure

- `src/index.ts` - Main entry point and Discord bot setup
- `src/config.ts` - Configuration and environment variables
- `src/asr-setup.ts` - Parses and validates `ASR_CONFIGURATIONS` against the vxasr catalogue at startup
- `src/transcription-service.ts` - Subscribes to voice receivers, one `UserAudioStream` per speaker
- `src/user-audio-stream.ts` - Decodes opus, downsamples once to 16 kHz mono, segments speech with Silero VAD
- `src/opus-stream.ts` - Opus → 48 kHz stereo PCM via `opus-decoder` (pure WASM, no native build, no patch)
- `src/utterance.ts` - One speech segment: recording + Discord message + transcription job
- `src/recording.ts` - Append-only 16 kHz mono PCM buffer; the source of truth for every attempt
- `src/paced-feeder.ts` - Cursor over the recording feeding a vxasr session; unifies live streaming and retry replay
- `src/transcription-job.ts` - Attempt loop: 5 attempts, 1/2/4/8 s backoff, rotates through the configuration list, watchdog after `finish()`
- `src/throttled-message-updater.ts` - Discord message lifecycle; partial edits with 0.5 s debounce + 1.5 s throttle
- `src/downsample.ts` - Streaming 48 kHz stereo → 16 kHz mono (3:1 averaging)
- `src/fake-timers.ts` - Deterministic clock for tests
- `src/usage-store.ts` - SQLite ledger: one row per **attempt**, and the totals the budget reads
- `src/budget.ts` - Decides whether another utterance may start; pure, so it is testable without Discord
- `src/session-transcript.ts` - Collects a session's utterances and renders the CSV (RFC 4180 escaping)
- `src/pending-utterances.ts` - Counts utterances still at the vendor, so `/transcriber stop` knows when the file is complete
- `src/transcription.ts` - Re-export shim

## Environment Setup

Required environment variables in `.env` file:
- `DISCORD_TOKEN` - Discord bot token
- `OPENROUTER_API_KEY` - OpenRouter key, required by the **default** configuration `openrouter/microsoft/mai-transcribe-1.5`
- `DASHSCOPE_API_KEY` - Alibaba Cloud DashScope key; needed only if `ASR_CONFIGURATIONS` names a qwen / qwen-omni model
- `ASR_CONFIGURATIONS` - (Optional) Comma-separated vxasr configuration ids in retry order
- `SILENCE_DURATION` / `STALL_TIMEOUT_MS` / `RECEIVER_SILENCE_MS` - (Optional) Segmentation timings; see `.env.example`
- `ASR_SESSION_REUSE` - (Optional) `0` disables qwen-omni connection reuse
- `USAGE_DB` / `BUDGET_USD` / `BUDGET_PER_GUILD_USD` / `BUDGET_PERIOD` - (Optional) Cost ledger and spend caps; see `.env.example`
- `LOG_LEVEL` - (Optional) Logging level (1=error, 2=warn, 3=log, 4=info, 5=debug)

## TypeScript Configuration

- This project uses Node.js native TypeScript support (no transpilation)
- `--experimental-transform-types` is required: the code uses constructor parameter properties (non-erasable syntax)
- Important tsconfig.json settings:
  - `allowImportingTsExtensions: true` - Allows importing .ts files directly
  - `verbatimModuleSyntax: true` - Ensures type imports use the `type` keyword
  - `noEmit: true` - No JavaScript files are generated

## Important Implementation Details

- **Transcription (vxasr)**:
  - Uses [vxasr](https://github.com/dtinth/vxbeamer/tree/main/packages/vxasr) `0.1.0` for multi-provider streaming ASR
  - The `Recording` owns each utterance's audio; sessions read through a cursor, so a failed session loses nothing
  - The paced feeder starts streaming while the person is still speaking — a streaming provider (qwen) shows live partials during speech; qwen-omni streams its transcript after `finish()`
  - Retry replays the whole recording: fast-dump when the configuration's `supportsFastDump` metadata says so, realtime pacing otherwise
  - **A cleanly ended session is NOT closed by the bot.** The provider owns its connection once the turn ends, and `qwen-omni` offers it to the reuse pool right after `onEnd`; closing there would terminate it first and disable reuse with no error, only a larger bill. Every other ending (error, watchdog, abort) still closes, since nothing else would
  - Session reuse (`ASR_SESSION_REUSE`, on by default) passes the `(session, speaker)` key as vxasr's `clientId`, so a speaker's next utterance keeps the previous turn's context — better on short sentences, but the vendor re-bills prior turns as context (measured +87% over six turns, `scripts/measure-session-reuse.ts`), bounded by `QWEN_OMNI_STICKY_MAX_AUDIO_SECONDS` (default 100)
  - After 5 failed attempts the message shows an error with the audio attached as WAV
  - Empty/whitespace transcript → the message is deleted (no speech)

- **Audio Processing**:
  - Opus decoding via `opus-decoder` (`wasm-audio-decoders`), pure WASM
  - **This replaced `prism-media` + `opusscript` and a `pnpm patch`.** opusscript computed its WASM heap views in element units against a byte address, so every decode wrote outside its own allocation and corrupted another decoder as soon as two people spoke — the bot went deaf mid-call. The fix was a private patch against a package last released in 2023, applied by pnpm, which a Deno-only project cannot do. `opus-decoder` needs no patch; `deno task verify` proves the audio is correct rather than merely that the module imports
  - 48 kHz stereo is downsampled exactly once, at ingest, to 16 kHz mono (3:1 group averaging)
  - Both VAD and vxasr consume the same 16 kHz mono stream
  - A ~320 ms pre-roll is kept while not speaking, so the syllable that triggers the VAD is not clipped
  - Uses Silero VAD model for voice activity detection (frame = 1024 samples / 64 ms)
  - Configurable silence duration and activation thresholds

- **Message Handling**:
  - Creates a placeholder message immediately, containing **no mention** — just `…`. Discord dispatches notifications when a message is *created*, never when it is edited, so the speaker's mention is added by the first edit and never pings them. `SuppressNotifications` alone is not enough: it silences the push but a mention still marks the channel unread for the person mentioned
  - Continuation messages for an over-long transcript carry no mention either — they are *sent*, so a mention in one would ping
  - Live partial text with 0.5 s debounce + 1.5 s throttle (Discord edit rate limits; qwen-omni rapid-fires partials at the end)
  - All Discord operations for one message are serialized through one promise chain
  - Final text bypasses debounce/throttle

- **Testing**:
  - `node:test` run by Deno — no test framework dependency
  - `testdata/speech.opus` holds real Discord-shaped Opus packets, committed so no test needs an encoder. The only encoder available was the removed `opusscript`, and proving the decoder with it would rest on the thing it replaced
  - `FakeTimers` (src/fake-timers.ts) drives all timing-sensitive tests deterministically
  - The vxasr `mock/mock` configuration gives a hermetic end-to-end path

## Cost tracking and budget

- Every **attempt** is written to SQLite (`node:sqlite`, built into Node and supported by Deno — no dependency), not every utterance. A failed attempt still spends money, and `TranscriptionResult` carries only the winning attempt's usage, so a ledger built from it under-counts
- The budget is checked **before** an utterance opens a vendor session — the only moment refusing is free. The documented consequence: the cap can be overshot by the utterances already in flight, which cannot be avoided without knowing a turn's price in advance
- A spent budget pauses transcription and says so once per session; the bot stays in the voice channel so `/transcriber stop` / `start` still behave normally. A new period releases it automatically
- `/transcriber usage` reports the **audio seconds** the guild transcribed this period — deliberately no money. The cost stays in the ledger, where the budget reads it; a channel is told what it transcribed, not what the operator pays
- Deno needs `--allow-write` for the SQLite file (see `test:deno`)

## Session transcript (`/transcriber stop`)

- `/transcriber stop` uploads the session as CSV: `started_at, ended_at, message_id, speaker_id, speaker_name, text`, ordered by when people spoke (utterances complete out of order when speakers overlap or a retry happens)
- **It waits, briefly, before sending.** The last utterance is nearly always still at the vendor when somebody stops the bot, and that is usually the part they want. Bounded by `DRAIN_TIMEOUT_MS` so a stalled vendor delays the file rather than preventing it; anything still missing is logged, not hidden
- The voice connection is destroyed *after* the file is built — tearing it down first aborts the very utterances the file would be missing
- An utterance that failed every attempt becomes a row with empty text: the transcript should show that something was said there and we do not have it. Silent utterances (deleted messages) are left out
- Escaping is RFC 4180 and tested by parsing the output back, not by matching the string — transcripts contain commas, quotes and newlines, and naive writing corrupts the file at the first quote
- Speaker names come from the guild cache and fall back to the id; a fetch here would put a network round trip in the transcription path

## Commands (slash, not prefix)

- `/transcriber start`, `/transcriber stop`, `/transcriber usage` — one command with three subcommands, defined in `src/commands.ts`, registered globally on `ClientReady`
- **The bot requests no privileged intent.** Its intents are `Guilds` and `GuildVoiceStates` only. Interactions carry the command in the payload, so nothing needs to read message text — the old `!` prefix was the *sole* reason `MessageContent` was requested, read by two lines that parsed a command name. Below 100 servers that intent is a checkbox; at 100 it becomes a Discord review of the application, at the worst possible moment
- **`stop` must `deferReply()` before draining.** An interaction has to be acknowledged within 3 s, and the drain waits up to `DRAIN_TIMEOUT_MS` (20 s) for the last transcripts. Replying directly would expire the interaction and lose the very file the command exists to produce; deferring gives 15 minutes, and `editReply` carries the attachment
- `usage` replies ephemerally — a server's own usage is not news for the channel
- The invite needs the `applications.commands` scope, or registration fails and the command never appears
- There is no backward compatibility with the `!` prefix. It was removed deliberately: keeping it would keep the privileged intent, so we would pay the cost of prefixes and get none of the benefit

## Stats HTTP server

- `src/http-server.ts` serves `GET /healthz` and `GET /stats` on `HTTP_PORT` (default 3000), bound to `HTTP_HOST` (default `127.0.0.1`)
- **It exists to time a redeploy.** A restart drops every voice connection and abandons whatever is still at the vendor, and from outside the process an idle bot and a busy one look identical
- `busy` is the field that answers the question — true when any session has a speaker mid-utterance or an utterance still at the vendor. `activeSessions` alone would block a redeploy for sessions that are merely *open*, which is most of them
- **Elysia's `listen()` throws on Deno.** Deno loads Elysia's WebStandard adapter, whose `listen` is a stub that raises "WebStandard does not support listen". The supported path is `Deno.serve(..., app.fetch)`, which is what `startStatsServer` does
- **Tests must use a realistic host in the request URL.** Elysia finds the path with `indexOf("/", 11)`, so `http://x/stats` puts the path before that offset and every route 404s. A real request always carries a real host, so this is a test-only trap — `http://localhost/stats` is fine
- Binding is loopback by default because the response names every guild the bot transcribes for. In Docker `HTTP_HOST` must be `0.0.0.0`, or nothing outside the container can reach it at all
- **`compose.yaml` uses `expose`, not `ports`.** The port is documented for other containers on the network (`http://transcriber:3000`) and is deliberately not published to the host, so the guild list is not one `curl` away from anything that can reach the VPS. Reading it from the host is then `docker compose exec transcriber deno eval '…fetch…'` — which needs nothing installed, because `deno eval` runs with full permissions and deno is the image

## Recovering a lost transcript

- `deno task recover <channelId>` rebuilds the CSV from the channel's messages (`scripts/recover-transcript.ts`, logic in `src/recover-transcript.ts`, reusing `csvField` so the escaping is the tested one)
- **It works because the bot authored those messages.** Discord returns the content of an application's own messages whatever intents it holds, so recovery needs no MESSAGE CONTENT intent and no access to the running process
- Continuation messages carry no mention (a *sent* mention would ping the speaker), so the parser appends an unmatched message to the previous row instead of dropping it
- `started_at` is the message's creation — the placeholder is posted when speech is detected — and `ended_at` is its last edit. `speaker_name` is not in the message and comes back empty
- Read-only and safe to run against production while the bot is live

## Guild session bookkeeping (`src/guild-sessions.ts`)

- `activeTranscriptions` is a `GuildSessions`, not a bare `Map`. **Every removal is identity-checked** against the subscription that owns the entry (`deleteIf(guildId, subscription)`)
- Three places remove entries — the stop command, the idle sweep, and the voice connection's `Disconnected` listener. Removing by guild id alone lets a late caller evict a session it does not own, and that session then keeps running with nothing pointing at it: no command reaches it, the sweep cannot see it, `/stats` does not count it, and only a restart clears it
- **`joinVoiceChannel` returns the *same* connection object per guild.** `createVoiceConnection` looks up `getVoiceConnection(guildId, group)` and returns it whenever it is not destroyed. So a `Disconnected` listener added per session accumulates on one shared object and fires for sessions that replaced it — listeners are now detached in `closeSession` and by the handler itself
- **A draining session keeps its entry, marked `closing`.** The entry used to be deleted *before* a drain that waits up to 20 s, so the guild looked free; a `/transcriber start` in that gap opened a second session on the same voice connection, which the finishing stop then destroyed underneath it. Start and stop both refuse a `closing` guild, and the sweep skips it
- **`/transcriber stop` recovers a stuck guild.** With no entry but a live `getVoiceConnection(guildId)`, it destroys the connection and says so. Leaving the channel is always a valid answer to "stop", and without this the only cure for a lost entry is restarting the bot

## Idle sessions

- The bot leaves after `IDLE_TIMEOUT_MS` (default 1 800 000 ms = 30 min) with **no voice received**, and uploads the transcript on the way out — a meeting everybody walked away from still leaves its file
- **Idleness is measured on speech, never on channel membership.** "Am I alone?" is the wrong question: a radio bot holds the member count above zero for ever, and somebody genuinely AFK is still a member. `TranscriptionService.lastActivity` is touched from `receiver.speaking.on("start")`
- That touch is **before** the budget check on purpose. A session the budget has paused is still receiving voice, and walking out on people who are talking is worse than staying open a while longer
- The sweep runs once a minute. Against a 30-minute timeout the granularity is free, and it keeps the check off the audio path
- `idleMs()` returns 0 for a subscription the service has forgotten, so a stale id can never trigger a sweep
- `closeSession()` is shared by `/transcriber stop` and the sweep. The ordering it protects — build the transcript, *then* destroy the connection — is the easy thing to get wrong twice
- `/stats` reports `idleSeconds` per session, so an abandoned session is visible before the sweep collects it
- There is still no `voiceStateUpdate` listener. `VoiceConnectionStatus.Disconnected` remains the only voice handler, and reacts to *being* disconnected (kicked, moved, network)

## Code Style Guidelines

- Use TypeScript for type safety
- All type imports must use the `type` keyword
- Import local files with `.ts` extension, not `.js`
- Organize imports alphabetically
- Use async/await for asynchronous operations
- Add comprehensive error handling
- Include descriptive comments for complex logic
- Prefer const over let when variables won't be reassigned
- Use camelCase for variables and functions
- Use PascalCase for classes and interfaces
- Use object-oriented design with class-based encapsulation
- Leverage modern JavaScript features like async iterators
- Use structured logging with consola for better debugging

## Voice Activity Detection (VAD)

- Uses Silero VAD model through @ricky0123/vad-node
- Configurable activation (0.5) and deactivation (0.3) thresholds
- **The pause that ends an utterance shrinks as the utterance grows.** `silenceNeededAfter()` interpolates from `SILENCE_DURATION` (1500 ms) down to `MIN_SILENCE_DURATION` (300 ms) as the utterance approaches `MAX_UTTERANCE_MS`, along `progress ** IMPATIENCE_EASING` (1.25). The exponent above 1 is what keeps the curve flat early: at 10 s an utterance still needs ~1446 ms, at 30 s ~1288 ms, and only near the cap does a breath suffice. Ordinary speech is measurably untouched — `pipeline.test.ts` asserts byte-identical segmentation at the shipped defaults
- The idea is from [dtinth/live-speech](https://github.com/dtinth/live-speech), which expresses it as a decay rate on a level envelope that accelerates with segment length. Restating it in milliseconds keeps the knob readable, and keeps our audio-clock design
- `MAX_UTTERANCE_MS` (120 s) remains as the **hard backstop**, and is now the *only* rule that can cut mid-word. Impatience needs a pause to act on, so sound that never dips at all — music, a tone, a room that is never quiet — is all that still reaches it. That is the case it was written for. live-speech has no such backstop and its segments can grow without limit on a sustained sound; ours must keep one
- Three timings, ordered on purpose: `SILENCE_DURATION` (1500 ms, audio clock) ends an utterance while packets flow; `STALL_TIMEOUT_MS` (2000 ms, wall clock) takes over when audio stops arriving; `RECEIVER_SILENCE_MS` (2500 ms) is when Discord ends the stream and is the ceiling on both
- Uses hysteresis pattern to avoid rapid on/off switching during speech
- Every 64 ms frame is processed (no frames skipped)
- **Two clocks, deliberately.** A pause between utterances is measured on the
  *audio clock* (`audioMs`, advanced per VAD frame), so utterance boundaries
  depend on what was said and not on when packets arrived — measuring it with
  `Date.now()` let a post-reconnect burst merge two sentences. A stalled stream
  (no audio arriving at all) is the opposite question and stays *wall-clock*
  (`lastChunkAt`), because when delivery stops the audio clock stops too and an
  open utterance would otherwise never be finalized.
