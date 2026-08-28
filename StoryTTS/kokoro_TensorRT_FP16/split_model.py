"""Tensor-only Kokoro frontend/decoder split for TensorRT export."""

from __future__ import annotations

import torch
from torch import nn


class KokoroFrontend(nn.Module):
    """Predict durations and encoder features without materializing alignment."""

    def __init__(self, kmodel: nn.Module):
        super().__init__()
        self.kmodel = kmodel

    def forward(
        self,
        input_ids: torch.Tensor,
        ref_s: torch.Tensor,
        speed: torch.Tensor,
    ) -> tuple[torch.Tensor, torch.Tensor, torch.Tensor]:
        batch = input_ids.shape[0]
        tokens = input_ids.shape[1]
        input_lengths = torch.full(
            (batch,), tokens, device=input_ids.device, dtype=torch.long
        )
        positions = torch.arange(tokens, device=input_ids.device).unsqueeze(0)
        positions = positions.expand(batch, -1).type_as(input_lengths)
        text_mask = positions + 1 > input_lengths.unsqueeze(1)

        bert = self.kmodel.bert(input_ids, attention_mask=(~text_mask).int())
        duration_encoding = self.kmodel.bert_encoder(bert).transpose(-1, -2)
        style = ref_s[:, 128:]
        prosody = self.kmodel.predictor.text_encoder(
            duration_encoding, style, input_lengths, text_mask
        )
        duration_state, _ = self.kmodel.predictor.lstm(prosody)
        duration = self.kmodel.predictor.duration_proj(duration_state)
        duration = torch.sigmoid(duration).sum(dim=-1) / speed.reshape(1, 1)
        duration = torch.round(duration).clamp(min=1).long()

        text = self.kmodel.text_encoder(input_ids, input_lengths, text_mask)
        return prosody, text, duration


class KokoroDecoder(nn.Module):
    """Synthesize audio from host-expanded, exact-length encoder features."""

    def __init__(self, kmodel: nn.Module):
        super().__init__()
        self.kmodel = kmodel

    def forward(
        self,
        prosody_frames: torch.Tensor,
        text_frames: torch.Tensor,
        ref_s: torch.Tensor,
    ) -> torch.Tensor:
        style = ref_s[:, 128:]
        f0, noise = self.kmodel.predictor.F0Ntrain(prosody_frames, style)
        audio = self.kmodel.decoder(
            text_frames, f0, noise, ref_s[:, :128]
        )
        return audio.squeeze(0).squeeze(0)


def expand_features(
    prosody: torch.Tensor,
    text: torch.Tensor,
    duration: torch.Tensor,
) -> tuple[torch.Tensor, torch.Tensor]:
    """Build the exact alignment used by upstream repeat_interleave."""
    token_indices = torch.repeat_interleave(
        torch.arange(duration.shape[1], device=duration.device), duration[0]
    )
    alignment = torch.nn.functional.one_hot(
        token_indices, num_classes=duration.shape[1]
    ).transpose(0, 1)
    alignment = alignment.unsqueeze(0).to(dtype=prosody.dtype)
    prosody_frames = prosody.transpose(-1, -2) @ alignment
    text_frames = text @ alignment
    return prosody_frames, text_frames
