# Discord Transcriber Bot Development Guide

## Commands

- `pnpm install` - Install dependencies
- `pnpm dev` - Start development server with hot reloading
- `pnpm start` - Start the application
- `pnpm test` - Run unit tests (node:test, hermetic — no network, no credentials)
- `pnpm typecheck` - Run TypeScript type checking

## Project Structure

- `src/index.ts` - Main entry point and Discord bot setup
- `src/config.ts` - Configuration and environment variables
- `src/asr-setup.ts` - Parses and validates `ASR_CONFIGURATIONS` against the vxasr catalogue at startup
- `src/transcription-service.ts` - Subscribes to voice receivers, one `UserAudioStream` per speaker
- `src/user-audio-stream.ts` - Decodes opus, downsamples once to 16 kHz mono, segments speech with Silero VAD
- `src/utterance.ts` - One speech segment: recording + Discord message + transcription job
- `src/recording.ts` - Append-only 16 kHz mono PCM buffer; the source of truth for every attempt
- `src/paced-feeder.ts` - Cursor over the recording feeding a vxasr session; unifies live streaming and retry replay
- `src/transcription-job.ts` - Attempt loop: 5 attempts, 1/2/4/8 s backoff, rotates through the configuration list, watchdog after `finish()`
- `src/throttled-message-updater.ts` - Discord message lifecycle; partial edits with 0.5 s debounce + 1.5 s throttle
- `src/downsample.ts` - Streaming 48 kHz stereo → 16 kHz mono (3:1 averaging)
- `src/fake-timers.ts` - Deterministic clock for tests
- `src/usage-store.ts` - SQLite ledger: one row per **attempt**, and the totals the budget reads
- `src/budget.ts` - Decides whether another utterance may start; pure, so it is testable without Discord
- `src/transcription.ts` - Re-export shim

## Environment Setup

Required environment variables in `.env` file:
- `DISCORD_TOKEN` - Discord bot token
- `DASHSCOPE_API_KEY` - Alibaba Cloud DashScope key (for the default qwen-omni configuration)
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
  - Uses [vxasr](https://github.com/dtinth/vxbeamer/tree/main/packages/vxasr) (`0.1.0-next` line) for multi-provider streaming ASR
  - The `Recording` owns each utterance's audio; sessions read through a cursor, so a failed session loses nothing
  - The paced feeder starts streaming while the person is still speaking — a streaming provider (qwen) shows live partials during speech; qwen-omni streams its transcript after `finish()`
  - Retry replays the whole recording: fast-dump when the configuration's `supportsFastDump` metadata says so, realtime pacing otherwise
  - **A cleanly ended session is NOT closed by the bot.** The provider owns its connection once the turn ends, and `qwen-omni` offers it to the reuse pool right after `onEnd`; closing there would terminate it first and disable reuse with no error, only a larger bill. Every other ending (error, watchdog, abort) still closes, since nothing else would
  - Session reuse (`ASR_SESSION_REUSE`, on by default) passes the `(session, speaker)` key as vxasr's `clientId`, so a speaker's next utterance keeps the previous turn's context — better on short sentences, but the vendor re-bills prior turns as context (measured +87% over six turns, `scripts/measure-session-reuse.ts`), bounded by `QWEN_OMNI_STICKY_MAX_AUDIO_SECONDS` (default 100)
  - After 5 failed attempts the message shows an error with the audio attached as WAV
  - Empty/whitespace transcript → the message is deleted (no speech)

- **Audio Processing**:
  - Opus decoding via prism-media with opusscript (WASM; no native modules)
  - 48 kHz stereo is downsampled exactly once, at ingest, to 16 kHz mono (3:1 group averaging)
  - Both VAD and vxasr consume the same 16 kHz mono stream
  - A ~320 ms pre-roll is kept while not speaking, so the syllable that triggers the VAD is not clipped
  - Uses Silero VAD model for voice activity detection (frame = 1024 samples / 64 ms)
  - Configurable silence duration and activation thresholds

- **Message Handling**:
  - Creates placeholder "*Listening...*" messages immediately
  - Live partial text with 0.5 s debounce + 1.5 s throttle (Discord edit rate limits; qwen-omni rapid-fires partials at the end)
  - All Discord operations for one message are serialized through one promise chain
  - Final text bypasses debounce/throttle

- **Testing**:
  - `node:test` with `node --experimental-transform-types --test` — no test framework dependency, Deno-friendly
  - `FakeTimers` (src/fake-timers.ts) drives all timing-sensitive tests deterministically
  - The vxasr `mock/mock` configuration gives a hermetic end-to-end path

## Cost tracking and budget

- Every **attempt** is written to SQLite (`node:sqlite`, built into Node and supported by Deno — no dependency), not every utterance. A failed attempt still spends money, and `TranscriptionResult` carries only the winning attempt's usage, so a ledger built from it under-counts
- The budget is checked **before** an utterance opens a vendor session — the only moment refusing is free. The documented consequence: the cap can be overshot by the utterances already in flight, which cannot be avoided without knowing a turn's price in advance
- A spent budget pauses transcription and says so once per session; the bot stays in the voice channel so `!stop` / `!transcribe` still behave normally. A new period releases it automatically
- `!cost` reports the period's spend for the guild and overall
- Deno needs `--allow-write` for the SQLite file (see `test:deno`)

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
- `MAX_UTTERANCE_MS` (120 s) splits an utterance that never pauses — music or a noisy room otherwise grows one without limit. It splits and continues, so no audio is dropped
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
