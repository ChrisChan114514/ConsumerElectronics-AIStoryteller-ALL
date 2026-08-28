"""Small fixed-language frontend for the Kokoro-Lite distillation experiment."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import torch
from torch import nn


def load_config(path: str | Path) -> dict[str, Any]:
    import yaml

    with Path(path).open(encoding="utf-8") as handle:
        return dict(yaml.safe_load(handle))


class LiteFrontend(nn.Module):
    """Predict phoneme duration and coarse prosody without PL-BERT."""

    def __init__(self, config: dict[str, Any]):
        super().__init__()
        hidden = int(config.get("hidden_dim", 256))
        layers = int(config.get("num_layers", 4))
        heads = int(config.get("num_heads", 4))
        ff_dim = int(config.get("ff_dim", hidden * 3))
        dropout = float(config.get("dropout", 0.1))
        self.max_tokens = int(config.get("max_tokens", 256))
        self.embedding = nn.Embedding(int(config["vocab_size"]), hidden, padding_idx=0)
        self.position = nn.Embedding(self.max_tokens, hidden)
        del heads
        self.encoder = nn.ModuleList(
            [LiteContextBlock(hidden, ff_dim, dropout) for _ in range(layers)]
        )
        self.norm = nn.LayerNorm(hidden)
        self.duration_head = nn.Linear(hidden, 1)
        self.f0_head = nn.Linear(hidden, 1)
        self.energy_head = nn.Linear(hidden, 1)
        self.voiced_head = nn.Linear(hidden, 1)

    def forward(
        self, input_ids: torch.Tensor, attention_mask: torch.Tensor | None = None
    ) -> dict[str, torch.Tensor]:
        if input_ids.ndim != 2:
            raise ValueError(f"input_ids must be [batch,tokens], got {input_ids.shape}")
        batch, tokens = input_ids.shape
        if tokens > self.max_tokens:
            raise ValueError(f"token count {tokens} exceeds max_tokens={self.max_tokens}")
        if attention_mask is None:
            attention_mask = input_ids.ne(0)
        positions = torch.arange(tokens, device=input_ids.device).unsqueeze(0)
        hidden = self.embedding(input_ids) + self.position(positions)
        mask = attention_mask.bool().unsqueeze(-1)
        for layer in self.encoder:
            hidden = layer(hidden)
            hidden = hidden * mask
        hidden = self.norm(hidden)
        duration = torch.nn.functional.softplus(self.duration_head(hidden).squeeze(-1))
        f0 = torch.nn.functional.softplus(self.f0_head(hidden).squeeze(-1))
        energy = self.energy_head(hidden).squeeze(-1)
        voiced = self.voiced_head(hidden).squeeze(-1)
        return {
            "hidden": hidden,
            "duration": duration,
            "f0": f0,
            "energy": energy,
            "voiced": voiced,
        }


class LiteContextBlock(nn.Module):
    """Dynamic-shape-friendly local context block for ONNX export."""

    def __init__(self, hidden: int, ff_dim: int, dropout: float):
        super().__init__()
        self.norm_conv = nn.LayerNorm(hidden)
        self.conv = nn.Conv1d(hidden, hidden, kernel_size=5, padding=2, groups=hidden)
        self.mix = nn.Conv1d(hidden, hidden, kernel_size=1)
        self.norm_ff = nn.LayerNorm(hidden)
        self.ff = nn.Sequential(
            nn.Linear(hidden, ff_dim),
            nn.GELU(),
            nn.Dropout(dropout),
            nn.Linear(ff_dim, hidden),
        )
        self.dropout = nn.Dropout(dropout)

    def forward(self, hidden: torch.Tensor) -> torch.Tensor:
        residual = hidden
        value = self.norm_conv(hidden).transpose(1, 2)
        value = self.mix(torch.nn.functional.gelu(self.conv(value))).transpose(1, 2)
        hidden = residual + self.dropout(value)
        return hidden + self.dropout(self.ff(self.norm_ff(hidden)))


def count_parameters(model: nn.Module) -> int:
    return sum(parameter.numel() for parameter in model.parameters())
