"""OpenAI-style gateway for the official CosyVoice FastAPI runtime.

Run the upstream runtime separately (see README), then run this gateway. Keeping
the model process separate makes it easy to replace the upstream runtime without
changing the product-facing API.
"""
from __future__ import annotations

import asyncio
import io
import os
import wave
from pathlib import Path

import httpx
from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field


class SpeechRequest(BaseModel):
    input: str = Field(min_length=1, max_length=12000)
    voice: str = "narrator"
    response_format: str = "wav"


app = FastAPI(title="CosyVoice3 RTX 5060 gateway")
UPSTREAM = os.getenv("COSYVOICE_URL", "http://127.0.0.1:2225").rstrip("/")
PROMPT_WAV = Path(os.getenv("VOICE_PROMPT", "/app/voices/narrator.wav"))
SAMPLE_RATE = int(os.getenv("COSYVOICE_SAMPLE_RATE", "24000"))
MAX_CONCURRENCY = max(1, int(os.getenv("MAX_CONCURRENCY", "1")))
API_KEY = os.getenv("TTS_API_KEY")
slot = asyncio.Semaphore(MAX_CONCURRENCY)


def check_key(value: str | None) -> None:
    if API_KEY and value != API_KEY:
        raise HTTPException(status_code=401, detail="invalid API key")


def pcm16_wav(raw: bytes) -> bytes:
    out = io.BytesIO()
    with wave.open(out, "wb") as stream:
        stream.setnchannels(1)
        stream.setsampwidth(2)
        stream.setframerate(SAMPLE_RATE)
        stream.writeframes(raw)
    return out.getvalue()


async def synthesize(text: str) -> bytes:
    if not PROMPT_WAV.exists():
        raise HTTPException(status_code=500, detail=f"Missing reference voice WAV: {PROMPT_WAV}")
    data = {"tts_text": f"<|en|>{text}"}
    async with httpx.AsyncClient(timeout=600) as client:
        with PROMPT_WAV.open("rb") as prompt:
            files = {"prompt_wav": (PROMPT_WAV.name, prompt, "audio/wav")}
            response = await client.post(f"{UPSTREAM}/inference_cross_lingual", data=data, files=files)
    response.raise_for_status()
    return pcm16_wav(response.content)


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok", "upstream": UPSTREAM, "sample_rate": str(SAMPLE_RATE)}


@app.post("/v1/audio/speech")
async def speech(request: SpeechRequest, x_api_key: str | None = Header(default=None)) -> StreamingResponse:
    check_key(x_api_key)
    if request.response_format.lower() != "wav":
        raise HTTPException(status_code=400, detail="this gateway currently returns wav only")
    async with slot:
        data = await synthesize(request.input)
    return StreamingResponse(io.BytesIO(data), media_type="audio/wav")
