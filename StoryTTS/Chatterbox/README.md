# Chatterbox-Turbo on RTX 5060

Chatterbox-Turbo is the expressive English option. It needs a short reference narrator clip, so the same `voices/narrator.wav` should be used for every run. The official model can also emit paralinguistic tags, but this fixed comparison story deliberately uses plain text so that prosody differences are easier to hear.

Upstream: [Resemble AI Chatterbox](https://github.com/resemble-ai/chatterbox). The project is MIT-licensed. The official Turbo path uses `ChatterboxTurboTTS.from_pretrained(device="cuda")` and `generate(..., audio_prompt_path=...)`; it also applies an audio watermark. Confirm the model terms and watermark policy for the final product.

## Remote start

First copy a consented 6-10 second English WAV to `voices/narrator.wav` on the RTX 5060 host, then:

```bash
cd WebService/StoryTTS/Chatterbox
docker compose build
docker compose up -d
python -m pip install -r requirements.txt
python sample.py --base-url http://127.0.0.1:2223/v1
python bench.py --base-url http://127.0.0.1:2223/v1 --concurrency 2 --server-slots 1 --requests 16
```

`MAX_CONCURRENCY=1` is intentional. Raise it to 2 only after checking `nvidia-smi`, tail latency and output stability. A queue in front of a single model is usually cheaper and more predictable than uncontrolled parallel model copies.
