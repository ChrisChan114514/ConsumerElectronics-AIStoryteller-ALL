# Fun-CosyVoice3 0.5B on RTX 5060

CosyVoice3 is the most controllable option in this set. The included `server.py` is a product-facing gateway; the model itself runs in the official CosyVoice FastAPI process. The gateway sends the fixed story and a reference WAV to the official `/inference_cross_lingual` endpoint and converts its PCM stream to a normal WAV response.

Upstream: [QwenAudio/CosyVoice](https://github.com/QwenAudio/CosyVoice). The repository is Apache-2.0. Its official runtime supports Fun-CosyVoice3 and has streaming/server examples. Use the official model/runtime files rather than copying model weights into this workspace.

## Remote start

On the RTX 5060 host, install the upstream runtime in its documented Python 3.10 environment and download the model. A typical launch is:

```bash
git clone https://github.com/QwenAudio/CosyVoice.git
cd CosyVoice
# create the documented Python 3.10 environment and install the upstream requirements
python runtime/python/fastapi/server.py --port 2225 --model_dir pretrained_models/Fun-CosyVoice3-0.5B
```

The `--model_dir` may be a local model directory or the upstream ModelScope/Hugging Face identifier. Follow the current upstream README for model download and CUDA/TensorRT options. In a second shell, from this folder:

```bash
cd WebService/StoryTTS/CosyVoice
docker compose build
docker compose up -d
python -m pip install -r requirements.txt
python sample.py --base-url http://127.0.0.1:2224/v1
python bench.py --base-url http://127.0.0.1:2224/v1 --concurrency 2 --server-slots 1 --requests 16
```

Copy the consented reference clip to `voices/narrator.wav` before starting the gateway. `COSYVOICE_SAMPLE_RATE=24000` matches the current Fun-CosyVoice3 configuration; confirm the value printed/returned by the upstream runtime and change the environment variable if your build uses another rate.

Begin with one model slot. Increase the gateway `MAX_CONCURRENCY` only after checking VRAM and p95 latency. For large batch workloads, a durable queue plus one or more measured GPU workers is preferable to spawning a model per request.
