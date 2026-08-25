# syntax=docker/dockerfile:1
FROM denoland/deno:2.9.5

WORKDIR /app

# Dependencies first, so a source change does not re-download them.
COPY deno.json deno.lock ./

# `--allow-scripts` is required, not optional: the Silero VAD is
# `onnxruntime-node`, a native Node-API module whose postinstall fetches the
# binary for this architecture. Without it the image builds, starts, joins the
# voice channel — and detects no speech at all.
RUN deno install --frozen --allow-scripts=npm:onnxruntime-node

COPY src ./src
COPY scripts ./scripts
COPY testdata/speech.opus testdata/speech.wav ./testdata/

# Refuse to ship an image that cannot hear. This decodes real Opus packets and
# compares the audio with the source, rather than merely importing the module —
# the decoder this project replaced imported perfectly and corrupted its own
# heap. It also initialises the VAD for this architecture.
RUN deno task verify

# Cache the compiled modules so the container starts without compiling first.
RUN deno cache src/index.ts

# The usage ledger decides when the budget stops the bot. Inside the container
# filesystem it is lost on every deploy, and a budget that forgets what it spent
# is not a budget — so it lives on a volume.
ENV USAGE_DB=/data/usage.db
RUN mkdir -p /data && chown deno:deno /data
VOLUME ["/data"]

USER deno
CMD ["deno", "run", "--allow-all", "src/index.ts"]
