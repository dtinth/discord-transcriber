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

- Deno 2.9 or later (this project does not run on Node)
- Discord Bot Token
- An API key for at least one vxasr provider (`OPENROUTER_API_KEY` for the default model)

## Setup

1. Clone the repository
2. Install dependencies:
   ```
   deno install --frozen --allow-scripts=npm:onnxruntime-node
   ```
   `--allow-scripts` is required: the voice-activity model is a native module
   whose binary is fetched by a postinstall. Without it the bot starts, joins
   the channel, and detects no speech.
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
6. Invite the bot with the `bot` **and** `applications.commands` scopes.
   Without the second scope the slash commands cannot be registered, and
   `/transcriber` never appears when somebody types `/`.

   **No privileged intent is needed.** The bot is driven by slash commands, so
   it never asks to read what people write. Leave MESSAGE CONTENT INTENT off.

## Deploying with Docker

Images are published to `ghcr.io/dtinth/discord-transcriber` for `linux/amd64`
and `linux/arm64` on every push to `main`.

```bash
cp .env.example .env    # fill in DISCORD_TOKEN and OPENROUTER_API_KEY
docker compose up -d
docker compose logs -f
```

Update with `docker compose pull && docker compose up -d`.

**The `/data` volume is not optional.** It holds `usage.db`, the record of what
has been spent. Without it every redeploy restarts the totals at zero, so the
budget never stops anything — and nothing announces that, until the bill does.

## Usage

Start the bot:
```
deno task dev
```

In Discord, use the following commands:
- `/transcriber start` - Start transcribing the voice channel you're in
- `/transcriber stop` - Stop transcribing and upload the transcript as CSV
- `/transcriber usage` - How much audio this server has transcribed (private reply)

The commands are registered globally when the bot logs in.

## Stats endpoint

The bot serves its own status on `HTTP_PORT` (default 3000, loopback only):

```bash
curl localhost:3000/stats
curl localhost:3000/healthz
```

```json
{
  "startedAt": "2026-08-30T12:00:00.000Z",
  "uptimeSeconds": 5400,
  "activeSessions": 1,
  "busy": false,
  "sessions": [
    {
      "guildId": "…", "channelId": "…",
      "startedAt": "2026-08-30T13:20:00.000Z", "uptimeSeconds": 600,
      "speakers": 0, "pendingUtterances": 0, "transcribed": 42
    }
  ]
}
```

**Check `busy` before a redeploy.** A restart drops every voice connection and
abandons any utterance still at the vendor. `busy` is true when somebody is
speaking or a transcript is still coming back — that is the moment a restart
loses words. `activeSessions` on its own is not the signal: a session with
nobody speaking restarts harmlessly.

Set `HTTP_PORT=0` to switch the server off.

## Idle sessions

The bot leaves a voice channel after 30 minutes with no voice received
(`IDLE_TIMEOUT_MS`), and uploads the transcript as it goes, so a session
everybody walked away from still leaves its file behind.

It is measured on **speech**, not on who is in the channel — a radio bot or an
AFK member would otherwise keep a dead session open indefinitely. Set
`IDLE_TIMEOUT_MS=0` to disable it.

## Development

```
deno task check    # Type checking
deno task test     # Unit tests (no network, no credentials)
deno task verify   # Prove this checkout can decode audio and load the VAD
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
- Replay pacing is per provider: a provider whose vxasr metadata declares `supportsFastDump` gets the backlog immediately, others get realtime pacing
- Uses the Silero VAD model with a hysteresis pattern (separate activation/deactivation thresholds)
- Opus decoding uses `opus-decoder` (pure WASM) — no native compilation
- Uses consola for structured logging with configurable verbosity levels

## License

ISC
