"""OpenAI-compatible Kokoro service using ONNX Runtime TensorRT FP16."""

from __future__ import annotations

import asyncio
import io
import os
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np
import onnxruntime as ort
import soundfile as sf
from fastapi import FastAPI, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel, Field

from kokoro_onnx import Kokoro
from kokoro_onnx.chunker import split_phonemes
from split_runtime import CACHE as TRT_CACHE
from split_runtime import MODEL_DIR, SplitSession

ROOT = Path(__file__).resolve().parent
VOICES_PATH = ROOT / "voices" / "voices-v1.0.bin"
PORT = int(os.getenv("PORT", "2229"))
MAX_WORKERS = max(1, int(os.getenv("KOKORO_TRT_WORKERS", "4")))
MAX_PHONEMES = max(32, min(510, int(os.getenv("KOKORO_TRT_MAX_PHONEMES", "128"))))


class TensorRTKokoro(Kokoro):
    def _split_phonemes(self, phonemes: str) -> list[str]:
        return split_phonemes(phonemes, MAX_PHONEMES)


def _make_tts() -> Kokoro:
    if not VOICES_PATH.exists():
        raise RuntimeError(f"Voices missing: {VOICES_PATH}")
    available = ort.get_available_providers()
    if "TensorrtExecutionProvider" not in available:
        raise RuntimeError(f"TensorrtExecutionProvider unavailable: {available}")
    return TensorRTKokoro.from_session(SplitSession(), str(VOICES_PATH))


tts = _make_tts()
executor = ThreadPoolExecutor(max_workers=MAX_WORKERS, thread_name_prefix="kokoro-trt")
slots = asyncio.Semaphore(MAX_WORKERS)
app = FastAPI(title="Kokoro split ONNX GPU service")


class SpeechRequest(BaseModel):
    model: str = "kokoro"
    voice: str = "af_heart"
    input: str = Field(min_length=1, max_length=20000)
    response_format: str = "wav"
    speed: float = Field(default=1.0, ge=0.5, le=2.0)
    trim: bool = True
    sentence_pause: float = Field(default=0.25, ge=0.0, le=2.0)
    clause_pause: float = Field(default=0.1, ge=0.0, le=2.0)


class TeacherLabelRequest(SpeechRequest):
    """Offline-only labels used to train the Kokoro-Lite student."""


def _teacher_labels(request: TeacherLabelRequest) -> dict[str, object]:
    """Return phoneme-level durations from the exact teacher session.

    The endpoint is disabled by default because labels expose internal model
    information and are intended for offline dataset preparation only.
    """
    if os.getenv("KOKORO_ENABLE_TEACHER_LABELS", "0") != "1":
        raise PermissionError("teacher labels are disabled")
    voice, phonemes, batches = tts._prepare(
        request.input,
        request.voice,
        request.speed,
        "en-us",
        False,
        request.sentence_pause,
        request.clause_pause,
    )
    all_tokens: list[int] = []
    all_durations: list[int] = []
    batch_info: list[dict[str, object]] = []
    for batch_phonemes, _pause in batches:
        tokens = tts.tokenizer.tokenize(batch_phonemes)
        if not tokens:
            continue
        style = tts._style_for(voice, len(tokens))
        inputs = {
            "input_ids": np.array([[0, *tokens, 0]], dtype=np.int64),
            "style": np.asarray(style, dtype=np.float32),
            "speed": np.array([request.speed], dtype=np.float32),
        }
        _waveform, duration = tts.sess.run(None, inputs)
        waveform_samples = int(np.asarray(_waveform).size)
        duration = np.asarray(duration).ravel().astype(np.int64)
        # The two padding tokens are part of the teacher graph but not part of
        # the student phoneme sequence.
        inner = duration[1:-1] if len(duration) == len(tokens) + 2 else duration
        all_tokens.extend(tokens)
        all_durations.extend(int(value) for value in inner)
        batch_info.append(
            {
                "phonemes": tts.tokenizer.known(batch_phonemes),
                "tokens": tokens,
                "durations": [int(value) for value in inner],
                "pad_left_frames": int(duration[0]) if len(duration) == len(tokens) + 2 else 0,
                "pad_right_frames": int(duration[-1]) if len(duration) == len(tokens) + 2 else 0,
                "audio_samples": waveform_samples,
            }
        )
    if len(all_tokens) != len(all_durations):
        raise RuntimeError("teacher duration/token alignment mismatch")
    return {
        "phonemes": tts.tokenizer.known(phonemes),
        "tokens": all_tokens,
        "durations": all_durations,
        "frame_count": int(sum(all_durations)),
        "audio_samples": int(sum(int(item["audio_samples"]) for item in batch_info)),
        "batches": batch_info,
    }


def _synthesize(request: SpeechRequest) -> bytes:
    audio, sample_rate = tts.create(
        request.input,
        voice=request.voice,
        speed=request.speed,
        lang="en-us",
        trim=request.trim,
        sentence_pause=request.sentence_pause,
        clause_pause=request.clause_pause,
    )
    if request.response_format != "wav":
        raise ValueError("TensorRT FP16 experiment supports response_format=wav only")
    output = io.BytesIO()
    sf.write(output, np.asarray(audio, dtype=np.float32), sample_rate, format="WAV", subtype="PCM_16")
    return output.getvalue()


@app.on_event("startup")
async def warmup() -> None:
    loop = asyncio.get_running_loop()
    await loop.run_in_executor(executor, lambda: _synthesize(SpeechRequest(input="Warmup text.")))


@app.get("/health")
def health() -> dict[str, object]:
    return {
        "status": "ok",
        "providers": tts.sess.component_providers,
        "available_providers": ort.get_available_providers(),
        "model": f"kokoro-split-{tts.sess.runtime_mode}",
        "model_dir": str(MODEL_DIR),
        "precision": (
            "frontend-fp16-decoder-fp32"
            if tts.sess.runtime_mode == "hybrid-trt-cuda"
            else "mixed-fp16-experimental"
        ),
        "workers": MAX_WORKERS,
        "max_phonemes_per_batch": MAX_PHONEMES,
        "engine_cache": str(TRT_CACHE),
        "max_observed_frames": tts.sess.max_observed_frames,
        "last_wave_peak": tts.sess.last_wave_peak,
        "last_wave_rms": tts.sess.last_wave_rms,
    }


@app.get("/v1/models")
def models() -> dict[str, object]:
    return {"object": "list", "data": [{"id": "kokoro", "object": "model"}]}


@app.post("/v1/audio/speech")
async def speech(request: SpeechRequest) -> Response:
    if request.model != "kokoro":
        raise HTTPException(status_code=400, detail="model must be kokoro")
    async with slots:
        loop = asyncio.get_running_loop()
        try:
            data = await loop.run_in_executor(executor, _synthesize, request)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except Exception as exc:
            raise HTTPException(status_code=500, detail=str(exc)) from exc
    return Response(content=data, media_type="audio/wav")


@app.post("/v1/teacher/labels")
async def teacher_labels(request: TeacherLabelRequest) -> dict[str, object]:
    if os.getenv("KOKORO_ENABLE_TEACHER_LABELS", "0") != "1":
        raise HTTPException(status_code=404, detail="teacher labels are disabled")
    async with slots:
        loop = asyncio.get_running_loop()
        try:
            return await loop.run_in_executor(executor, _teacher_labels, request)
        except PermissionError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        except Exception as exc:
            raise HTTPException(status_code=500, detail=str(exc)) from exc


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("server:app", host="0.0.0.0", port=PORT, workers=1)
