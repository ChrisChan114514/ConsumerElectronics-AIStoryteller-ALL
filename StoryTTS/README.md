# StoryTTS RTX 5060 deployment candidates

This directory contains four remote-only deployment plans for an RTX 5060 8 GB server. Each candidate has its own server/client code, dependency file, fixed story, concurrency benchmark, and remote sample-generation command.

No model is downloaded, no GPU inference is started, and no audio is generated on the development machine. The `samples/` directories intentionally contain instructions only. Run `sample.py` on the RTX 5060 host and copy the resulting WAV/MP3 files back for listening.

## Candidates

| Folder | Model | Expected role | Operational notes |
|---|---|---|---|
| `Kokoro` | Kokoro-82M | Default production candidate for English stories | Fast, many preset voices, OpenAI-compatible FastAPI container; scale with one worker/container per GPU or a queue |
| `Kitten` | KittenTTS mini 80M | Lowest-cost quality baseline | Small model and simple API; pin the current GPU-capable package and verify CUDA backend on the remote host |
| `Chatterbox` | Chatterbox-Turbo 350M | More expressive English narration | Requires a clean reference voice WAV; use one inference slot first; the official model applies an audio watermark |
| `CosyVoice` | Fun-CosyVoice3 0.5B | Highest control/expressiveness candidate | Heavier stack and reference WAV; use the official runtime, then expose the included OpenAI-style gateway |

The official sources and licenses used for these plans are linked from each folder README: Kokoro (Apache-2.0), KittenTTS (Apache-2.0), Chatterbox (MIT), and CosyVoice (Apache-2.0). Check each upstream license and model terms again before commercial launch.

## Same test for every model

1. Place `story.txt` and the candidate folder on the remote Linux host.
2. Start that candidate's service using its README. For CUDA 12.8 / RTX 50-series, use the candidate's CUDA 12.8 image or environment.
3. Run the sample command. It writes `samples/<candidate>_story.wav` (or `.mp3` for Kokoro) on the remote host.
4. Run the benchmark at concurrency 1, 2, 4 and 8. Compare p50/p95 latency, real-time factor (RTF), errors, and GPU memory. An RTF below 1.0 means generation is faster than playback.

The fixed story is deliberately identical across candidates. Chatterbox and CosyVoice additionally require a reference clip in their `voices/` folder; use the same narrator clip for a fair voice-quality comparison.

## Suggested first pass on an RTX 5060

Start with Kokoro at concurrency 4. If GPU memory remains below about 7 GB and p95 is stable, try 8. Keep Chatterbox and CosyVoice at concurrency 1-2 until the benchmark proves that more slots are safe. For a high-volume batch product, put a queue in front of the service and run multiple containers/processes only after measuring VRAM and tail latency.

The scripts are intentionally HTTP based so they can be run from another machine. They do not assume that the benchmark client and the GPU server are the same host.
