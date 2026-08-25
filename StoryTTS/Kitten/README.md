# KittenTTS mini on RTX 5060

This is the lightweight baseline. It wraps the upstream KittenTTS package in a small FastAPI service and requests the CUDA backend. The package API has changed between releases, so the adapter has a compatibility fallback; confirm `/health` reports `backend=cuda` and check `nvidia-smi` before using it for production.

Upstream: [KittenML/KittenTTS](https://github.com/KittenML/KittenTTS). The upstream project is Apache-2.0. `requirements.txt` uses the official 0.8.1 wheel and the upstream GPU dependency list; keep those versions fixed after the remote qualification run.

## Remote start

```bash
cd WebService/StoryTTS/Kitten
docker compose build
docker compose up -d
python -m pip install -r requirements.txt
python sample.py --base-url http://127.0.0.1:8000/v1
python bench.py --base-url http://127.0.0.1:8000/v1 --concurrency 4 --requests 32
```

The server serializes only up to `MAX_CONCURRENCY` GPU jobs (default 2), so the benchmark can include queued HTTP requests without causing an uncontrolled VRAM spike. Test 1, 2, 4 and 8 client concurrency levels and select the highest stable setting.
