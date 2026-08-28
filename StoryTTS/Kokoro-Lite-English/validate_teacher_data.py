"""Validate the teacher dataset before training."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
import soundfile as sf


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--data-dir", type=Path, default=Path(__file__).with_name("teacher_data"))
    args = parser.parse_args()
    total = 0
    failures: list[str] = []
    for manifest in sorted(args.data_dir.glob("*.jsonl")):
        if manifest.name == "manifest.jsonl":
            continue
        for line in manifest.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            item = json.loads(line)
            try:
                audio_path = args.data_dir / item["audio"]
                label_path = args.data_dir / item["labels"]
                audio, rate = sf.read(audio_path, dtype="float32")
                with np.load(label_path) as labels:
                    ids = labels["input_ids"]
                    durations = labels["durations"]
                    for key in ("f0", "energy", "voiced"):
                        if len(labels[key]) != len(ids):
                            raise ValueError(f"{key} length mismatch")
                        if not np.isfinite(labels[key]).all():
                            raise ValueError(f"{key} contains non-finite values")
                    if len(ids) != len(durations) or len(ids) == 0:
                        raise ValueError("token/duration length mismatch")
                    if (ids < 0).any() or (durations < 1).any():
                        raise ValueError("invalid token or duration")
                    if int(durations.sum()) <= 0:
                        raise ValueError("zero duration")
                if rate != 24000 or not np.isfinite(audio).all() or np.max(np.abs(audio)) > 1.1:
                    raise ValueError("invalid audio")
                total += 1
            except Exception as exc:
                failures.append(f"{item.get('id', manifest.name)}: {exc}")
    print(f"items={total} failures={len(failures)}")
    for failure in failures[:20]:
        print(f"FAIL {failure}")
    if failures:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
