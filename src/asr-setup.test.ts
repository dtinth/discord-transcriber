import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { test } from "node:test";
import { loadAsrSetup } from "./asr-setup.ts";
import { Recording } from "./recording.ts";
import { runTranscriptionJob } from "./transcription-job.ts";

test("parses an ordered list and validates it", () => {
  const setup = loadAsrSetup(
    " mock/mock , qwen-omni/qwen3.5-omni-flash-realtime-2026-03-15 ",
    { DASHSCOPE_API_KEY: "k" }
  );
  assert.deepEqual(
    setup.configurations.map((definition) => definition.id),
    ["mock/mock", "qwen-omni/qwen3.5-omni-flash-realtime-2026-03-15"]
  );
});

test("rejects an unknown configuration id, listing what exists", () => {
  assert.throws(() => loadAsrSetup("nope/nope", {}), /Unknown ASR configuration "nope\/nope"/);
  assert.throws(() => loadAsrSetup("nope/nope", {}), /mock\/mock/);
});

test("rejects a configuration whose credentials are missing", () => {
  assert.throws(
    () => loadAsrSetup("qwen-omni/qwen3.5-omni-flash-realtime-2026-03-15", {}),
    /DASHSCOPE_API_KEY/
  );
});

test("rejects an empty list", () => {
  assert.throws(() => loadAsrSetup(" , ", {}), /empty/);
});

test("end to end against the real vxasr mock provider", async () => {
  const setup = loadAsrSetup("mock/mock", {});
  const recording = new Recording();
  recording.append(Buffer.alloc(32000)); // 1 s of silence-shaped PCM
  recording.end();

  const partials: string[] = [];
  const result = await runTranscriptionJob({
    recording,
    configurations: setup.configurations,
    env: setup.env,
    onPartial: (text) => partials.push(text),
  });

  assert.match(result.text, /Good morning everyone/);
  assert.equal(result.configurationId, "mock/mock");
  assert.equal(result.attempt, 1);
  assert.ok(partials.length > 0);
});
