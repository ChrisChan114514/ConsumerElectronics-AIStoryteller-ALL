"""Generate Kokoro teacher WAVs and labels for the Lite-English student.

The teacher URL must point at kokoro_TensorRT_FP16. Labels are returned by its
offline-only /v1/teacher/labels endpoint, so this script never guesses
phoneme durations from waveform silence.
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
from pathlib import Path

import httpx
import numpy as np
import soundfile as sf
import torch
import torchaudio


ROOT = Path(__file__).resolve().parent


def split_name(text: str) -> str:
    value = int(hashlib.sha1(text.encode("utf-8")).hexdigest()[:8], 16) % 100
    return "valid" if value < 10 else "test" if value < 20 else "train"


def frame_features(audio: np.ndarray, frame_count: int, sample_rate: int) -> tuple[np.ndarray, np.ndarray]:
    if frame_count <= 0:
        raise ValueError("teacher returned no frames")
    waveform = torch.from_numpy(np.asarray(audio, dtype=np.float32))
    if waveform.ndim > 1:
        waveform = waveform.mean(dim=1)
    with torch.inference_mode():
        f0 = torchaudio.functional.detect_pitch_frequency(
            waveform.unsqueeze(0), sample_rate, frame_time=0.025
        )[0]
    f0 = torch.nan_to_num(f0, nan=0.0, posinf=0.0, neginf=0.0).cpu().numpy()
    hop = max(1, sample_rate // 40)
    padded = torch.nn.functional.pad(waveform, (0, max(0, frame_count * hop - waveform.numel())))
    frames = padded[: frame_count * hop].reshape(frame_count, hop)
    energy = torch.sqrt(torch.mean(frames * frames, dim=1) + 1e-8).numpy()
    source_x = np.linspace(0.0, 1.0, num=max(1, len(f0)), dtype=np.float32)
    target_x = np.linspace(0.0, 1.0, num=frame_count, dtype=np.float32)
    f0 = np.interp(target_x, source_x, f0).astype(np.float32)
    silence_threshold = max(1e-4, float(np.percentile(energy, 90)) * 0.08)
    f0[energy < silence_threshold] = 0.0
    return f0, np.log1p(energy).astype(np.float32)


def phoneme_features(
    frame_values: np.ndarray, durations: list[int]
) -> np.ndarray:
    output: list[float] = []
    cursor = 0
    for duration in durations:
        count = max(1, int(duration))
        values = frame_values[cursor : cursor + count]
        output.append(float(values.mean()) if len(values) else 0.0)
        cursor += count
    return np.asarray(output, dtype=np.float32)


def crop_padding(audio: np.ndarray, batches: list[dict[str, object]]) -> np.ndarray:
    """Remove graph padding frames so features align with student tokens."""
    parts: list[np.ndarray] = []
    cursor = 0
    samples_per_frame = 600
    for batch in batches:
        samples = int(batch["audio_samples"])
        raw = audio[cursor : cursor + samples]
        cursor += samples
        left = int(batch.get("pad_left_frames", 0)) * samples_per_frame
        right = int(batch.get("pad_right_frames", 0)) * samples_per_frame
        end = len(raw) - right if right else len(raw)
        parts.append(raw[left:end])
    if cursor != len(audio):
        raise ValueError(f"teacher batch samples {cursor} do not match WAV samples {len(audio)}")
    return np.concatenate(parts)


def request_json(client: httpx.Client, url: str, payload: dict[str, object]) -> dict[str, object]:
    response = client.post(url, json=payload)
    response.raise_for_status()
    return response.json()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--teacher-url", default="http://127.0.0.1:2229")
    parser.add_argument("--text-file", type=Path, default=ROOT / "datasets/example.jsonl")
    parser.add_argument("--output-dir", type=Path, default=ROOT / "teacher_data")
    parser.add_argument("--voice", default="af_heart")
    parser.add_argument("--speed", type=float, default=1.0)
    parser.add_argument("--max-items", type=int, default=0)
    parser.add_argument("--overwrite", action="store_true")
    parser.add_argument("--timeout", type=float, default=300.0)
    args = parser.parse_args()
    if not args.text_file.exists():
        raise SystemExit(f"Missing text file: {args.text_file}")

    records: list[dict[str, object]] = []
    for line_no, line in enumerate(args.text_file.read_text(encoding="utf-8").splitlines(), 1):
        if not line.strip():
            continue
        try:
            record = json.loads(line)
        except json.JSONDecodeError as exc:
            raise SystemExit(f"Invalid JSONL at line {line_no}: {exc}") from exc
        text = str(record.get("text", "")).strip()
        if not text:
            continue
        item_id = str(record.get("id") or f"item_{line_no:06d}")
        records.append({"id": item_id, "text": text})
        if args.max_items and len(records) >= args.max_items:
            break
    if not records:
        raise SystemExit("No text records found")

    output = args.output_dir
    audio_dir, label_dir = output / "audio", output / "labels"
    audio_dir.mkdir(parents=True, exist_ok=True)
    label_dir.mkdir(parents=True, exist_ok=True)
    manifests: dict[str, list[dict[str, object]]] = {"train": [], "valid": [], "test": []}
    base = args.teacher_url.rstrip("/")
    labels_url = f"{base}/v1/teacher/labels"
    speech_url = f"{base}/v1/audio/speech"
    with httpx.Client(timeout=args.timeout) as client:
        health = client.get(f"{base}/health")
        health.raise_for_status()
        print(f"teacher={health.json().get('model')} providers={health.json().get('providers')}")
        for index, record in enumerate(records, 1):
            item_id, text = str(record["id"]), str(record["text"])
            split = split_name(item_id)
            audio_path = audio_dir / f"{item_id}.wav"
            label_path = label_dir / f"{item_id}.npz"
            if not args.overwrite and audio_path.exists() and label_path.exists():
                print(f"[{index}/{len(records)}] skip {item_id}")
                manifests[split].append({"id": item_id, "text": text, "split": split, "audio": str(audio_path.relative_to(output)), "labels": str(label_path.relative_to(output))})
                continue
            request = {
                "model": "kokoro",
                "voice": args.voice,
                "input": text,
                "speed": args.speed,
                "trim": False,
                "sentence_pause": 0.0,
                "clause_pause": 0.0,
            }
            labels = request_json(client, labels_url, request)
            response = client.post(speech_url, json={**request, "response_format": "wav"})
            response.raise_for_status()
            audio, sample_rate = sf.read(io.BytesIO(response.content), dtype="float32")
            if sample_rate != 24000:
                raise RuntimeError(f"unexpected teacher sample rate {sample_rate}")
            audio = crop_padding(np.asarray(audio, dtype=np.float32), labels["batches"])
            tokens = np.asarray(labels["tokens"], dtype=np.int64)
            durations = [int(value) for value in labels["durations"]]
            if len(tokens) != len(durations) or not durations:
                raise RuntimeError(f"invalid labels for {item_id}")
            frame_count = int(sum(durations))
            f0_frames, energy_frames = frame_features(audio, frame_count, sample_rate)
            f0 = phoneme_features(f0_frames, durations)
            energy = phoneme_features(energy_frames, durations)
            voiced = (f0 > 0).astype(np.float32)
            np.savez_compressed(label_path, input_ids=tokens, durations=np.asarray(durations, dtype=np.int64), f0=f0, energy=energy, voiced=voiced)
            sf.write(audio_path, audio, sample_rate, subtype="PCM_16")
            meta = {"id": item_id, "text": text, "voice": args.voice, "speed": args.speed, "split": split, "sample_rate": sample_rate, "num_samples": int(np.asarray(audio).size), "frame_count": frame_count, "audio": str(audio_path.relative_to(output)), "labels": str(label_path.relative_to(output))}
            manifests[split].append(meta)
            print(f"[{index}/{len(records)}] {item_id} tokens={len(tokens)} frames={frame_count} samples={meta['num_samples']}")
    for split, values in manifests.items():
        path = output / f"{split}.jsonl"
        path.write_text("".join(json.dumps(value, ensure_ascii=False) + "\n" for value in values), encoding="utf-8")
    (output / "manifest.json").write_text(json.dumps({"teacher_url": base, "voice": args.voice, "sample_rate": 24000, "items": sum(map(len, manifests.values()))}, indent=2), encoding="utf-8")
    print(f"Wrote {sum(map(len, manifests.values()))} items under {output}")


if __name__ == "__main__":
    main()
