"""OpenAI-style Chatterbox-Turbo service for a single RTX 5060."""
from __future__ import annotations

import asyncio
import io
import os
from pathlib import Path
from typing import Any

import numpy as np
import soundfile as sf
from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

try:
    from chatterbox.tts_turbo import ChatterboxTurboTTS
except ImportError as exc:  # gives a useful startup error on an old package
    raise RuntimeError("Install a chatterbox-tts release that includes ChatterboxTurboTTS") from exc


class SpeechRequest(BaseModel):
    input: str = Field(min_length=1, max_length=12000)
    voice: str = "narrator"
    response_format: str = "wav"


app = FastAPI(title="Chatterbox Turbo RTX 5060")
DEVICE = os.getenv("CHATTERBOX_DEVICE", "cuda")
VOICE_PROMPT = Path(os.getenv("VOICE_PROMPT", "/app/voices/narrator.wav"))
MAX_CONCURRENCY = max(1, int(os.getenv("MAX_CONCURRENCY", "1")))
API_KEY = os.getenv("TTS_API_KEY")
model: Any = None
slot = asyncio.Semaphore(MAX_CONCURRENCY)


@app.on_event("startup")
def load_model() -> None:
    global model
    if not VOICE_PROMPT.exists():
        raise RuntimeError(f"Missing reference voice WAV: {VOICE_PROMPT}")
    model = ChatterboxTurboTTS.from_pretrained(device=DEVICE)


def check_key(value: str | None) -> None:
    if API_KEY and value != API_KEY:
        raise HTTPException(status_code=401, detail="invalid API key")


def synthesize(text: str) -> bytes:
    generated = model.generate(text, audio_prompt_path=str(VOICE_PROMPT))
    audio = generated.detach().float().cpu().numpy()
    audio = np.squeeze(audio)
    out = io.BytesIO()
    sf.write(out, audio, int(model.sr), format="WAV", subtype="PCM_16")
    return out.getvalue()


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "device": DEVICE, "voice_prompt": str(VOICE_PROMPT)}


@app.post("/v1/audio/speech")
async def speech(request: SpeechRequest, x_api_key: str | None = Header(default=None)) -> StreamingResponse:
    check_key(x_api_key)
    if request.response_format.lower() != "wav":
        raise HTTPException(status_code=400, detail="this adapter currently returns wav only")
    async with slot:
        data = await asyncio.to_thread(synthesize, request.input)
    return StreamingResponse(io.BytesIO(data), media_type="audio/wav")
