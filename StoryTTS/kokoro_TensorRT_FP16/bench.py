"""Concurrent benchmark for the TensorRT FP16 service."""

from __future__ import annotations

import argparse
import asyncio
import io
import statistics
import time
import wave
from pathlib import Path

import httpx


def wav_seconds(data: bytes) -> float | None:
    try:
        with wave.open(io.BytesIO(data)) as wav:
            frames, rate = wav.getnframes(), wav.getframerate()
            if frames < 0x7FFFFFFF:
                return frames / rate
            data_chunk = getattr(wav, "_data_chunk", None)
            offset = getattr(data_chunk, "offset", 0)
            return max(0.0, len(data) - offset) / (rate * wav.getnchannels() * wav.getsampwidth())
    except (wave.Error, EOFError):
        return None


async def run(args: argparse.Namespace) -> None:
    text = Path(__file__).with_name("story.txt").read_text(encoding="utf-8")
    base_url = args.base_url.rstrip("/")
    endpoint = f"{base_url}/audio/speech" if base_url.endswith("/v1") else f"{base_url}/v1/audio/speech"
    semaphore = asyncio.Semaphore(args.concurrency)
    timings: list[float] = []
    rtfs: list[float] = []
    errors = 0
    async with httpx.AsyncClient(timeout=args.timeout) as client:
        async def one() -> None:
            nonlocal errors
            async with semaphore:
                started = time.perf_counter()
                try:
                    response = await client.post(
                        endpoint,
                        json={"model": "kokoro", "voice": args.voice, "input": text, "response_format": "wav"},
                    )
                    response.raise_for_status()
                    elapsed = time.perf_counter() - started
                    timings.append(elapsed)
                    duration = wav_seconds(response.content)
                    if duration:
                        rtfs.append(elapsed / duration)
                except Exception as exc:
                    errors += 1
                    print(f"request failed: {exc}")

        wall_started = time.perf_counter()
        await asyncio.gather(*(one() for _ in range(args.requests)))
    wall = time.perf_counter() - wall_started
    if not timings:
        raise SystemExit("All requests failed")
    ordered = sorted(timings)
    p95 = ordered[min(len(ordered) - 1, int(len(ordered) * 0.95))]
    print(f"requests={args.requests} ok={len(timings)} errors={errors} concurrency={args.concurrency}")
    print(f"wall_s={wall:.3f} throughput_req_s={len(timings) / wall:.3f} latency_p50_s={statistics.median(timings):.3f} latency_p95_s={p95:.3f}")
    if rtfs:
        print(f"rtf_mean={statistics.mean(rtfs):.3f} (less than 1.0 is faster than playback)")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-url", default="http://127.0.0.1:2229/v1")
    parser.add_argument("--voice", default="af_heart")
    parser.add_argument("--concurrency", type=int, default=2)
    parser.add_argument("--requests", type=int, default=32)
    parser.add_argument("--timeout", type=float, default=300)
    asyncio.run(run(parser.parse_args()))


if __name__ == "__main__":
    main()
