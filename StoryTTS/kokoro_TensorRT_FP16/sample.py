"""Generate the local story through the TensorRT FP16 server."""

from __future__ import annotations

import argparse
from pathlib import Path

import httpx


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-url", default="http://127.0.0.1:2229/v1")
    parser.add_argument("--voice", default="af_heart")
    parser.add_argument("--output", default="samples/kokoro_story_tensorrt_fp16.wav")
    args = parser.parse_args()
    text = Path(__file__).with_name("story.txt").read_text(encoding="utf-8")
    base_url = args.base_url.rstrip("/")
    endpoint = f"{base_url}/audio/speech" if base_url.endswith("/v1") else f"{base_url}/v1/audio/speech"
    response = httpx.post(
        endpoint,
        json={"model": "kokoro", "voice": args.voice, "input": text, "response_format": "wav"},
        timeout=300,
    )
    response.raise_for_status()
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_bytes(response.content)
    print(f"Wrote {output} ({len(response.content)} bytes)")


if __name__ == "__main__":
    main()
