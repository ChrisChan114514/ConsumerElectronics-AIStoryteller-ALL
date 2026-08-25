"""Small OpenAI-style HTTP wrapper around KittenTTS for one RTX 5060 host."""
from __future__ import annotations

import asyncio
import io
import os
from typing import Any

import numpy as np
import soundfile as sf
from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from kittentts import KittenTTS


class SpeechRequest(BaseModel):
    input: str = Field(min_length=1, max_length=12000)
    voice: str = "Luna"
    response_format: str = "wav"


app = FastAPI(title="KittenTTS RTX 5060")
MODEL_ID = os.getenv("KITTENTTS_MODEL", "KittenML/kitten-tts-mini-0.8")
BACKEND = os.getenv("KITTENTTS_BACKEND", "cuda")
MAX_CONCURRENCY = max(1, int(os.getenv("MAX_CONCURRENCY", "2")))
API_KEY = os.getenv("TTS_API_KEY")
model: Any = None
slot = asyncio.Semaphore(MAX_CONCURRENCY)


@app.on_event("startup")
def load_model() -> None:
    global model
    try:
        model = KittenTTS(MODEL_ID, backend=BACKEND)
    except TypeError:
        # Older package builds do not expose backend=; keep the endpoint usable
        # while the remote operator upgrades to the GPU-capable build.
        model = KittenTTS(MODEL_ID)


def check_key(value: str | None) -> None:
    if API_KEY and value != API_KEY:
        raise HTTPException(status_code=401, detail="invalid API key")


def synthesize(text: str, voice: str) -> bytes:
    audio = np.asarray(model.generate(text, voice=voice), dtype=np.float32)
    if audio.ndim > 1:
        audio = np.squeeze(audio)
    sample_rate = int(getattr(model, "sample_rate", getattr(model, "sr", 24000)))
    out = io.BytesIO()
    sf.write(out, audio, sample_rate, format="WAV", subtype="PCM_16")
    return out.getvalue()


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "model": MODEL_ID, "backend": BACKEND}


@app.post("/v1/audio/speech")
async def speech(request: SpeechRequest, x_api_key: str | None = Header(default=None)) -> StreamingResponse:
    check_key(x_api_key)
    if request.response_format.lower() != "wav":
        raise HTTPException(status_code=400, detail="this adapter currently returns wav only")
    async with slot:
        data = await asyncio.to_thread(synthesize, request.input, request.voice)
    return StreamingResponse(io.BytesIO(data), media_type="audio/wav")
