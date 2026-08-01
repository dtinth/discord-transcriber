# Discord Voice Transcriber Bot

A Discord bot that transcribes voice channel conversations using [vxasr](https://github.com/dtinth/vxbeamer/tree/main/packages/vxasr), a multi-provider streaming ASR client.

## Features

- Joins voice channels and listens to conversations
- Streams audio to an ASR provider while the person is still speaking
- Live partial transcripts, debounced and throttled, edited into the message in-place
- Retries with exponential backoff, rotating through a configurable provider list — a failed session loses no audio
- Attaches the audio as a WAV file if every attempt fails, so the sound is never lost
- Uses Silero voice activity detection (VAD) to filter out noise and background sounds
- Deletes the message when no speech is detected, keeping the channel clean
- Simple commands to start and stop transcription

## Prerequisites

- Node.js v24 or later
- Discord Bot Token
- An API key for at least one vxasr provider (e.g. `DASHSCOPE_API_KEY` for Qwen)

## Setup

1. Clone the repository
2. Install dependencies:
   ```
   pnpm install
   ```
3. Create a `.env` file based on the example:
   ```
   cp .env.example .env
   ```
4. Add your credentials to the `.env` file:
   ```
   DISCORD_TOKEN=your_discord_bot_token
   DASHSCOPE_API_KEY=your_dashscope_api_key
   LOG_LEVEL=4  # Optional: 1=error, 2=warn, 3=log, 4=info, 5=debug
   ```
5. (Optional) Choose model configurations. `ASR_CONFIGURATIONS` is a comma-separated list of [vxasr configuration ids](https://github.com/dtinth/vxbeamer/tree/main/packages/vxasr) in retry order:
   ```
   ASR_CONFIGURATIONS=qwen-omni/qwen3.5-omni-flash-realtime-2026-03-15,qwen/qwen3-asr-flash-realtime-2026-02-10
   ```
6. Configure Privileged Intents in the Discord Developer Portal:
   - Go to https://discord.com/developers/applications
   - Select your bot application
   - Go to the "Bot" section
   - Under "Privileged Gateway Intents", enable:
     - MESSAGE CONTENT INTENT
   - Save changes

## Usage

Start the bot:
```
pnpm dev
```

In Discord, use the following commands:
- `!transcribe` - Start transcribing the voice channel you're in
- `!stop` - Stop transcription

## Development

```
pnpm typecheck   # Type checking
pnpm test        # Unit tests (node:test, no network, no credentials)
```

## How It Works

1. The bot connects to a Discord voice channel
2. It captures audio streams from users as they speak
3. Opus audio is decoded and downsampled once to 16 kHz mono PCM
4. Voice activity detection (VAD) segments the stream into utterances
5. Each utterance's audio accumulates in a `Recording` — the source of truth
6. A paced feeder streams the recording into a vxasr session while the person speaks; a placeholder message appears immediately
7. Partial transcripts are edited into the message live (0.5 s debounce, 1.5 s throttle)
8. On session failure the job backs off (1/2/4/8 s) and retries — up to 5 attempts, rotating through `ASR_CONFIGURATIONS`; each retry replays the same recording from the start
9. The message is updated in-place with the final transcript, deleted when no speech was detected, or — after total failure — marked failed with the audio attached as a WAV

### Technical Details

- The recording buffer owns the audio; sessions only read it through a cursor, so no retry ever loses sound
- Replay pacing is per provider: providers confirmed to accept a fast dump (see `FAST_DUMP_PROVIDERS`) get the backlog immediately, others get realtime pacing
- Uses the Silero VAD model with a hysteresis pattern (separate activation/deactivation thresholds)
- Opus decoding uses opusscript (WASM) — no native compilation
- Uses consola for structured logging with configurable verbosity levels

## License

ISC
