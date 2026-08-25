# Remote listening and concurrency matrix

Run this file's commands on the RTX 5060 machine. Do not run them in the development workspace.

## Before the run

- Run `nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv` and save the result.
- Use the same `story.txt` for every candidate.
- For Chatterbox and CosyVoice, put the same consented English narrator clip at `voices/narrator.wav`.
- Start only one candidate at a time if VRAM is uncertain.

## Samples

| Candidate  | Service  | Remote command                                                      | Output                                      |
| ---------- | -------- | ------------------------------------------------------------------- | ------------------------------------------- |
| Kokoro     | `2221` | `python Kokoro/sample.py --base-url http://127.0.0.1:2221/v1`     | `Kokoro/samples/kokoro_story.wav`         |
| Kitten     | `2222` | `python Kitten/sample.py --base-url http://127.0.0.1:2222/v1`     | `Kitten/samples/kitten_story.wav`         |
| Chatterbox | `2223` | `python Chatterbox/sample.py --base-url http://127.0.0.1:2223/v1` | `Chatterbox/samples/chatterbox_story.wav` |
| CosyVoice  | `2224` | `python CosyVoice/sample.py --base-url http://127.0.0.1:2224/v1`  | `CosyVoice/samples/cosyvoice_story.wav`   |

Listen for pronunciation, pauses, sibilance, emotional range, voice consistency and unwanted artifacts. The script output is WAV so files can be compared without an encoder changing the result.

## Concurrency

```bash
cd WebService/StoryTTS
bash bench_matrix.sh | tee benchmark-$(date +%Y%m%d-%H%M%S).log
```

The script runs 1/2/4/8 client concurrency for Kokoro and Kitten, and 1/2/4 for the heavier models. Record p50, p95, throughput, RTF, error count, peak VRAM and GPU utilization. Repeat a failed or unstable level after a cold restart; do not average a warm run with a model-loading run.

## Decision rule

For the story-machine batch workload, first discard any candidate with unstable output or an RTF above 1.0 at the desired concurrency. Among the remaining candidates, prefer the lowest p95 cost per finished story while keeping pronunciation and emotion acceptable in a blind listening comparison. Keep the benchmark log and the exact upstream commit/container tag with the product release.
