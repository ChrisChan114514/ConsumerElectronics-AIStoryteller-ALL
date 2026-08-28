"""Dataset and padding utilities for teacher labels."""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import torch
from torch.utils.data import Dataset


class TeacherDataset(Dataset):
    def __init__(self, data_dir: str | Path, split: str = "train"):
        self.root = Path(data_dir)
        manifest = self.root / f"{split}.jsonl"
        if not manifest.exists():
            raise FileNotFoundError(manifest)
        self.items = [
            json.loads(line)
            for line in manifest.read_text(encoding="utf-8").splitlines()
            if line.strip()
        ]
        if not self.items:
            raise ValueError(f"empty dataset: {manifest}")

    def __len__(self) -> int:
        return len(self.items)

    def __getitem__(self, index: int) -> dict[str, torch.Tensor | str]:
        item = self.items[index]
        with np.load(self.root / item["labels"]) as labels:
            return {
                "id": item["id"],
                "input_ids": torch.from_numpy(labels["input_ids"].astype(np.int64)),
                "durations": torch.from_numpy(labels["durations"].astype(np.float32)),
                "f0": torch.from_numpy(labels["f0"].astype(np.float32)),
                "energy": torch.from_numpy(labels["energy"].astype(np.float32)),
                "voiced": torch.from_numpy(labels["voiced"].astype(np.float32)),
            }


def collate_teacher(batch: list[dict[str, torch.Tensor | str]]) -> dict[str, torch.Tensor | list[str]]:
    lengths = torch.tensor([item["input_ids"].numel() for item in batch], dtype=torch.long)
    max_tokens = int(lengths.max())
    keys = ("input_ids", "durations", "f0", "energy", "voiced")
    output: dict[str, torch.Tensor | list[str]] = {
        "lengths": lengths,
        "ids": [str(item["id"]) for item in batch],
    }
    for key in keys:
        values = torch.zeros((len(batch), max_tokens), dtype=torch.float32)
        if key == "input_ids":
            values = values.long()
        for row, item in enumerate(batch):
            value = item[key]
            values[row, : value.numel()] = value
        output[key] = values
    output["mask"] = torch.arange(max_tokens).unsqueeze(0) < lengths.unsqueeze(1)
    return output
