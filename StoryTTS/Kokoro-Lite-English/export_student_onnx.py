"""Export the Lite frontend checkpoint to a dynamic ONNX graph."""

from __future__ import annotations

import argparse
from pathlib import Path

import onnx
import torch

from student_model.model import LiteFrontend


def main() -> None:
    parser = argparse.ArgumentParser()
    root = Path(__file__).parent
    parser.add_argument("--checkpoint", type=Path, default=root / "checkpoints/frontend.pt")
    parser.add_argument("--output", type=Path, default=root / "models/kokoro-lite-frontend.onnx")
    args = parser.parse_args()
    checkpoint = torch.load(args.checkpoint, map_location="cpu", weights_only=False)
    model = LiteFrontend(checkpoint["config"]).eval()
    model.load_state_dict(checkpoint["model"])
    sample = torch.ones((1, 16), dtype=torch.long)
    mask = torch.ones((1, 16), dtype=torch.bool)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    torch.onnx.export(
        model,
        (sample, mask),
        args.output,
        input_names=["input_ids", "attention_mask"],
        output_names=["hidden", "duration", "f0", "energy", "voiced"],
        dynamic_axes={"input_ids": {1: "tokens"}, "attention_mask": {1: "tokens"}, "hidden": {1: "tokens"}, "duration": {1: "tokens"}, "f0": {1: "tokens"}, "energy": {1: "tokens"}, "voiced": {1: "tokens"}},
        opset_version=17,
        dynamo=False,
    )
    onnx.checker.check_model(onnx.load(args.output, load_external_data=False))
    print(f"saved={args.output} bytes={args.output.stat().st_size}")


if __name__ == "__main__":
    main()
