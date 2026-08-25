# Kokoro-82M on RTX 5060

Kokoro is the first candidate to try for English story batches. The included compose file pins the community Kokoro-FastAPI GPU image `v0.7.2-cu128`, using the CUDA 12.8 build needed by RTX 50-series hosts. It exposes an OpenAI-compatible `/v1/audio/speech` endpoint.

Upstream: [hexgrad/Kokoro model card](https://huggingface.co/hexgrad/Kokoro-82M), [remsky/Kokoro-FastAPI](https://github.com/remsky/Kokoro-FastAPI). The model card is Apache-2.0; verify the voice/model terms before shipping commercially.

## Remote start

On a Linux host with NVIDIA Container Toolkit:

```bash
cd WebService/StoryTTS/Kokoro
docker compose up -d
python -m pip install -r requirements.txt
python sample.py --base-url http://127.0.0.1:8880/v1 --voice af_heart
python bench.py --base-url http://127.0.0.1:8880/v1 --concurrency 4 --requests 32
```

Run the sample from the remote machine (or replace `127.0.0.1` with the GPU host address). Try `--voice af_bella`, `af_nicole`, and `am_michael` as additional English comparisons. Run the benchmark at concurrency 1, 2, 4, and 8; do not assume that a single model instance is thread-safe. For higher throughput, run several containers behind a queue after measuring VRAM and p95 latency.

The `samples/` directory is an output location only. This workspace does not contain a generated audio file because inference is intentionally remote-only.
