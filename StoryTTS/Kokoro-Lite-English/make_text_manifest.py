"""Convert a plain-text story corpus into the JSONL input format."""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("input", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--prefix", default="text")
    args = parser.parse_args()
    raw = args.input.read_text(encoding="utf-8")
    paragraphs = [part.strip().replace("\n", " ") for part in re.split(r"\n\s*\n", raw) if part.strip()]
    rows: list[dict[str, str]] = []
    for paragraph_index, paragraph in enumerate(paragraphs):
        sentences = re.split(r"(?<=[.!?])\s+", paragraph)
        for sentence_index, sentence in enumerate(sentences):
            sentence = sentence.strip()
            if sentence:
                rows.append({"id": f"{args.prefix}_{paragraph_index:04d}_{sentence_index:03d}", "text": sentence})
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text("".join(json.dumps(row, ensure_ascii=False) + "\n" for row in rows), encoding="utf-8")
    print(f"wrote={args.output} items={len(rows)}")


if __name__ == "__main__":
    main()
