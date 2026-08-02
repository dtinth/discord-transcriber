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

`src/pipeline.test.ts` feeds this as fast as the pipeline accepts it, and also
feeds it paced, then asserts both produce the same segments. Utterance
boundaries are decided on the audio clock — the audio the VAD has consumed —
so they do not depend on how the packets arrived.

That was not always true. Silence used to be measured with `Date.now()`, which
tied segmentation to network timing: a burst after a reconnect merged two
sentences into one utterance. The "does not depend on how fast the packets
arrive" test exists to keep that from coming back.
