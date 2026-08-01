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
- `src/paced-feeder.ts` - Cursor over the recording feeding a vxasr session; unifies live streaming and retry replay; `FAST_DUMP_PROVIDERS`
- `src/transcription-job.ts` - Attempt loop: 5 attempts, 1/2/4/8 s backoff, rotates through the configuration list, watchdog after `finish()`
- `src/throttled-message-updater.ts` - Discord message lifecycle; partial edits with 0.5 s debounce + 1.5 s throttle
- `src/downsample.ts` - Streaming 48 kHz stereo → 16 kHz mono (3:1 averaging)
- `src/fake-timers.ts` - Deterministic clock for tests
- `src/transcription.ts` - Re-export shim

## Environment Setup

Required environment variables in `.env` file:
- `DISCORD_TOKEN` - Discord bot token
- `DASHSCOPE_API_KEY` - Alibaba Cloud DashScope key (for the default qwen-omni configuration)
- `ASR_CONFIGURATIONS` - (Optional) Comma-separated vxasr configuration ids in retry order
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
  - Retry replays the whole recording: fast-dump for providers in `FAST_DUMP_PROVIDERS` (copied from vxbeamer's `evalRun.ts`; delete when vxasr exports it), realtime pacing otherwise
  - Vendors cap concurrent sockets: `session.close()` runs in a `finally` on every path
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
- 1 second silence duration before ending speech detection
- Uses hysteresis pattern to avoid rapid on/off switching during speech
- Every 64 ms frame is processed (no frames skipped)
