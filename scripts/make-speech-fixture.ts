/**
 * Regenerates `testdata/speech.wav`, the fixture the pipeline test feeds
 * through the receive path.
 *
 * Run only when the fixture must change — the result is committed, so the test
 * itself needs no credentials, no network, and stays byte-identical over time:
 *
 *   node --env-file=.env --experimental-transform-types scripts/make-speech-fixture.ts
 *
 * Speech, not a synthetic tone, because Silero VAD is trained on speech and a
 * tone does not reliably activate it. Two sentences separated by silence, so a
 * test can assert the VAD *splits* them rather than only noticing sound.
 */
import { Buffer } from "node:buffer";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MODEL = "qwen3-tts-flash";
const ENDPOINT =
  "https://dashscope-intl.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation";

/** Recorded in testdata/README.md so the expected transcript stays visible. */
export const SENTENCES = [
  "The quick brown fox jumps over the lazy dog.",
  "This recording is a fixture for the transcriber pipeline test.",
];

/** Gap between the sentences. Longer than the VAD's silence duration (1 s). */
const GAP_SECONDS = 1.6;

async function synthesize(text: string): Promise<Buffer> {
  const apiKey = process.env.DASHSCOPE_API_KEY;
  if (!apiKey) throw new Error("DASHSCOPE_API_KEY is required to regenerate the fixture");

  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      input: { text, voice: "Cherry", language_type: "English" },
    }),
  });

  const body = (await response.json()) as {
    output?: { audio?: { url?: string } };
    message?: string;
  };
  const url = body.output?.audio?.url;
  if (!url) throw new Error(`TTS failed: ${body.message ?? JSON.stringify(body)}`);

  const audio = await fetch(url);
  if (!audio.ok) throw new Error(`Downloading the audio failed: ${audio.status}`);
  return Buffer.from(await audio.arrayBuffer());
}

/** Whatever the vendor returned -> 16 kHz 16-bit mono, the pipeline's format. */
function toPcm16kMono(input: Buffer, workDir: string, name: string): Buffer {
  const inPath = join(workDir, `${name}.audio`);
  const outPath = join(workDir, `${name}.raw`);
  writeFileSync(inPath, input);
  execFileSync("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-i", inPath,
    "-ar", "16000", "-ac", "1", "-f", "s16le", "-acodec", "pcm_s16le",
    outPath,
  ]);
  return readFileSync(outPath);
}

function wavHeader(pcmBytes: number): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcmBytes, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(16000, 24);
  header.writeUInt32LE(16000 * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcmBytes, 40);
  return header;
}

const workDir = mkdtempSync(join(tmpdir(), "speech-fixture-"));
const parts: Buffer[] = [];

for (const [index, sentence] of SENTENCES.entries()) {
  console.log(`synthesizing: ${sentence}`);
  const audio = await synthesize(sentence);
  const pcm = toPcm16kMono(audio, workDir, `s${index}`);
  console.log(`  ${(pcm.length / 32000).toFixed(2)}s`);
  if (index > 0) parts.push(Buffer.alloc(Math.round(GAP_SECONDS * 32000)));
  parts.push(pcm);
}

const pcm = Buffer.concat(parts);
const outPath = new URL("../testdata/speech.wav", import.meta.url).pathname;
writeFileSync(outPath, Buffer.concat([wavHeader(pcm.length), pcm]));
console.log(`\nwrote ${outPath} — ${(pcm.length / 32000).toFixed(2)}s total`);
