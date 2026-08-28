#!/usr/bin/env bash
set -Eeuo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PYTHON_BIN="${PYTHON_BIN:-/home/cc/miniforge3/envs/pytorch/bin/python}"
export PORT="${PORT:-2229}"
export KOKORO_TRT_WORKERS="${KOKORO_TRT_WORKERS:-4}"
export KOKORO_TRT_MAX_PHONEMES="${KOKORO_TRT_MAX_PHONEMES:-128}"
export KOKORO_DECODER_PROVIDER="${KOKORO_DECODER_PROVIDER:-cuda}"
export OPENBLAS_NUM_THREADS="${OPENBLAS_NUM_THREADS:-1}"
export OMP_NUM_THREADS="${OMP_NUM_THREADS:-1}"
if [[ ! -x "${PYTHON_BIN}" ]]; then echo "Python not found: ${PYTHON_BIN}" >&2; exit 1; fi
RUNTIME_LIB_DIRS="$(${PYTHON_BIN} - <<'PY'
import pathlib
import sysconfig
site = pathlib.Path(sysconfig.get_paths()["purelib"])
paths = (
    site / "onnxruntime" / "capi",
    site / "tensorrt_libs",
    site / "nvidia" / "cublas" / "lib",
    site / "nvidia" / "cuda_runtime" / "lib",
    site / "nvidia" / "cudnn" / "lib",
)
print(":".join(str(path) for path in paths if path.is_dir()))
PY
)"
if [[ -n "${RUNTIME_LIB_DIRS}" ]]; then export LD_LIBRARY_PATH="${RUNTIME_LIB_DIRS}:${LD_LIBRARY_PATH:-}"; fi
exec "${PYTHON_BIN}" -m uvicorn server:app --app-dir "${ROOT_DIR}" --host 0.0.0.0 --port "${PORT}" --workers 1 --log-level info
