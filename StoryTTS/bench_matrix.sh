#!/usr/bin/env bash
set -euo pipefail

# Run this on the remote GPU host after the selected services are started.
# It intentionally does not install models or run on the development machine.

run_levels() {
  local folder="$1"
  local base_url="$2"
  local requests="$3"
  shift 3
  for level in "$@"; do
    echo "==== ${folder} concurrency=${level} ===="
    (cd "${folder}" && python bench.py --base-url "${base_url}" --concurrency "${level}" --requests "${requests}")
  done
}

run_levels Kokoro "http://127.0.0.1:8880/v1" 32 1 2 4 8
run_levels Kitten "http://127.0.0.1:8000/v1" 32 1 2 4 8
run_levels Chatterbox "http://127.0.0.1:8001/v1" 16 1 2 4
run_levels CosyVoice "http://127.0.0.1:8002/v1" 16 1 2 4
