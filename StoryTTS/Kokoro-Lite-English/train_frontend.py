"""Train the first Kokoro-Lite frontend on precomputed teacher labels."""

from __future__ import annotations

import argparse
import json
import random
from pathlib import Path

import numpy as np
import torch
import torch.nn.functional as F
from torch.utils.data import DataLoader

from student_model.data import TeacherDataset, collate_teacher
from student_model.model import LiteFrontend, count_parameters, load_config


def masked_smooth_l1(pred: torch.Tensor, target: torch.Tensor, mask: torch.Tensor) -> torch.Tensor:
    return F.smooth_l1_loss(pred[mask], target[mask])


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--data-dir", type=Path, default=Path(__file__).with_name("teacher_data"))
    root = Path(__file__).parent
    parser.add_argument("--config", type=Path, default=root / "configs/student_base.yaml")
    parser.add_argument("--output", type=Path, default=root / "checkpoints/frontend.pt")
    parser.add_argument("--epochs", type=int, default=0)
    parser.add_argument("--batch-size", type=int, default=0)
    parser.add_argument("--device", default="cuda" if torch.cuda.is_available() else "cpu")
    args = parser.parse_args()
    config = load_config(args.config)
    seed = int(config.get("seed", 7))
    random.seed(seed)
    np.random.seed(seed)
    torch.manual_seed(seed)
    device = torch.device(args.device)
    model = LiteFrontend(config).to(device)
    train = TeacherDataset(args.data_dir, "train")
    valid_manifest = args.data_dir / "valid.jsonl"
    valid = (
        TeacherDataset(args.data_dir, "valid")
        if valid_manifest.exists() and valid_manifest.stat().st_size > 0
        else None
    )
    loader = DataLoader(train, batch_size=args.batch_size or int(config["batch_size"]), shuffle=True, collate_fn=collate_teacher, pin_memory=device.type == "cuda")
    valid_loader = DataLoader(valid, batch_size=loader.batch_size, shuffle=False, collate_fn=collate_teacher) if valid else None
    optimizer = torch.optim.AdamW(model.parameters(), lr=float(config["learning_rate"]))
    scaler = torch.amp.GradScaler("cuda", enabled=device.type == "cuda")
    epochs = args.epochs or int(config["epochs"])
    best = float("inf")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    print(f"parameters={count_parameters(model)} device={device} train_items={len(train)}")
    for epoch in range(1, epochs + 1):
        model.train()
        train_loss = 0.0
        for batch in loader:
            ids = batch["input_ids"].to(device, non_blocking=True)
            mask = batch["mask"].to(device, non_blocking=True)
            with torch.autocast(device_type=device.type, dtype=torch.float16, enabled=device.type == "cuda"):
                output = model(ids, mask)
                durations = batch["durations"].to(device)
                f0 = batch["f0"].to(device)
                energy = batch["energy"].to(device)
                voiced = batch["voiced"].to(device)
                loss = float(config["weight_duration"]) * masked_smooth_l1(torch.log1p(output["duration"]), torch.log1p(durations), mask)
                voiced_mask = mask & voiced.gt(0.5)
                if voiced_mask.any():
                    loss = loss + float(config["weight_f0"]) * masked_smooth_l1(torch.log1p(output["f0"]), torch.log1p(f0), voiced_mask)
                loss = loss + float(config["weight_energy"]) * masked_smooth_l1(output["energy"], energy, mask)
                loss = loss + float(config["weight_voiced"]) * F.binary_cross_entropy_with_logits(output["voiced"][mask], voiced[mask])
            optimizer.zero_grad(set_to_none=True)
            scaler.scale(loss).backward()
            scaler.unscale_(optimizer)
            torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            scaler.step(optimizer)
            scaler.update()
            train_loss += float(loss.detach())
        train_loss /= max(1, len(loader))
        valid_loss = train_loss
        if valid_loader:
            model.eval()
            values = []
            with torch.inference_mode():
                for batch in valid_loader:
                    ids = batch["input_ids"].to(device)
                    mask = batch["mask"].to(device)
                    output = model(ids, mask)
                    durations = batch["durations"].to(device)
                    f0 = batch["f0"].to(device)
                    energy = batch["energy"].to(device)
                    voiced = batch["voiced"].to(device)
                    value = float(masked_smooth_l1(torch.log1p(output["duration"]), torch.log1p(durations), mask))
                    voiced_mask = mask & voiced.gt(0.5)
                    if voiced_mask.any():
                        value += float(config["weight_f0"]) * float(masked_smooth_l1(torch.log1p(output["f0"]), torch.log1p(f0), voiced_mask))
                    value += float(config["weight_energy"]) * float(masked_smooth_l1(output["energy"], energy, mask))
                    value += float(config["weight_voiced"]) * float(F.binary_cross_entropy_with_logits(output["voiced"][mask], voiced[mask]))
                    values.append(value)
            valid_loss = sum(values) / max(1, len(values))
        print(f"epoch={epoch} train_duration_loss={train_loss:.5f} valid_duration_loss={valid_loss:.5f}")
        if valid_loss < best:
            best = valid_loss
            torch.save({"config": config, "model": model.state_dict(), "epoch": epoch, "valid_loss": valid_loss}, args.output)
    if not args.output.exists():
        torch.save({"config": config, "model": model.state_dict(), "epoch": epochs, "valid_loss": valid_loss}, args.output)
    print(f"saved={args.output}")


if __name__ == "__main__":
    main()
