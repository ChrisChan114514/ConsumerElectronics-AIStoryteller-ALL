"""Generate the fixed story remotely from the Kitten adapter."""
from __future__ import annotations

import argparse
from pathlib import Path

import httpx


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-url", default="http://127.0.0.1:8000/v1")
    parser.add_argument("--voice", default="Luna")
    parser.add_argument("--output", default="samples/kitten_story.wav")
    args = parser.parse_args()
    text = Path(__file__).with_name("story.txt").read_text(encoding="utf-8")
    response = httpx.post(f"{args.base_url.rstrip('/')}/audio/speech", json={"input": text, "voice": args.voice, "response_format": "wav"}, timeout=300)
    response.raise_for_status()
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_bytes(response.content)
    print(f"Wrote {output} ({len(response.content)} bytes)")


if __name__ == "__main__":
    main()
