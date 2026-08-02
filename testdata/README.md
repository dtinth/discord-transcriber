# Test audio fixture

`speech.wav` — WAV, **16 kHz / 16-bit / mono**, 8.24 s. This is the format the
bot's pipeline works in, so a test can feed it straight through.

Generated with `pnpm fixture` (see `scripts/make-speech-fixture.ts`), which
synthesizes each sentence with DashScope `qwen3-tts-flash` and joins them with
silence. The result is **committed**, so `pnpm test` needs no credentials, no
network, and gives the same answer every run. Regenerate it only when the
fixture itself must change — the assertions in `src/pipeline.test.ts` depend on
its shape.

## Contents

1. "The quick brown fox jumps over the lazy dog."
2. *(1.6 s of silence)*
3. "This recording is a fixture for the transcriber pipeline test."

**The silence is load-bearing.** It is longer than the VAD's 1 s silence window,
so a correct pipeline splits this into exactly two utterances. A change that
merges them into one — or that chops a sentence into several — fails the test.

## Why synthesized speech rather than a tone

Silero VAD is trained on speech. A sine tone does not reliably activate it, so a
synthetic waveform would test the plumbing while proving nothing about the part
that decides when a person is talking.

## Pacing

`src/pipeline.test.ts` feeds this at realtime, one 20 ms packet per 20 ms, which
is why it takes ~11 s. That is not caution: `UserAudioStream` measures silence
with `Date.now()` rather than by counting the audio it has consumed, so a faster
feed compresses the gap between the sentences and the two utterances merge.
