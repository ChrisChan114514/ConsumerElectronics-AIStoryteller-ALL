"""Concurrent HTTP benchmark for the CosyVoice3 gateway."""
from __future__ import annotations

import argparse
import asyncio
import io
import statistics
import time
import wave
from pathlib import Path

import httpx


def duration(data: bytes) -> float | None:
    try:
        with wave.open(io.BytesIO(data)) as stream:
            return stream.getnframes() / stream.getframerate()
    except (wave.Error, EOFError):
        return None


async def run(args: argparse.Namespace) -> None:
    text = Path(__file__).with_name("story.txt").read_text(encoding="utf-8")
    semaphore = asyncio.Semaphore(args.concurrency)
    timings: list[float] = []
    rtfs: list[float] = []
    errors = 0
    async with httpx.AsyncClient(timeout=args.timeout) as client:
        async def request() -> None:
            nonlocal errors
            async with semaphore:
                started = time.perf_counter()
                try:
                    result = await client.post(f"{args.base_url.rstrip('/')}/audio/speech", json={"input": text, "voice": "narrator", "response_format": "wav"})
                    result.raise_for_status()
                    elapsed = time.perf_counter() - started
                    timings.append(elapsed)
                    seconds = duration(result.content)
                    if seconds:
                        rtfs.append(elapsed / seconds)
                except Exception as exc:
                    errors += 1
                    print(f"request failed: {exc}")

        wall_started = time.perf_counter()
        await asyncio.gather(*(request() for _ in range(args.requests)))
    wall = time.perf_counter() - wall_started
    if not timings:
        raise SystemExit("All requests failed")
    ordered = sorted(timings)
    p95 = ordered[min(len(ordered) - 1, int(len(ordered) * 0.95))]
    print(f"requests={args.requests} ok={len(timings)} errors={errors} client_concurrency={args.concurrency} server_slots={args.server_slots}")
    print(f"wall_s={wall:.3f} throughput_req_s={len(timings) / wall:.3f} latency_p50_s={statistics.median(timings):.3f} latency_p95_s={p95:.3f}")
    if rtfs:
        print(f"rtf_mean={statistics.mean(rtfs):.3f}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-url", default="http://127.0.0.1:2224/v1")
    parser.add_argument("--concurrency", type=int, default=2)
    parser.add_argument("--server-slots", type=int, default=1)
    parser.add_argument("--requests", type=int, default=16)
    parser.add_argument("--timeout", type=float, default=600)
    args = parser.parse_args()
    asyncio.run(run(args))


if __name__ == "__main__":
    main()
