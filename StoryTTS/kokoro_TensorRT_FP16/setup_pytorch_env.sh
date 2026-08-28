#!/usr/bin/env bash
set -Eeuo pipefail
PYTHON_BIN="${PYTHON_BIN:-/home/cc/miniforge3/envs/pytorch/bin/python}"
"${PYTHON_BIN}" -m pip uninstall -y onnxruntime >/dev/null 2>&1 || true
"${PYTHON_BIN}" -m pip install --upgrade --no-cache-dir 'onnxruntime-gpu[cuda,cudnn]==1.23.2' 'espeakng-loader>=0.2.4' 'phonemizer>=3.4.0' 'soundfile==0.14.0' 'fastapi>=0.115,<1' 'uvicorn[standard]>=0.34,<1' 'httpx>=0.28,<1'
"${PYTHON_BIN}" -m pip install --upgrade --no-cache-dir 'onnx==1.17.0' 'transformers==4.48.3' 'scipy==1.13.1' 'loguru==0.7.3'
"${PYTHON_BIN}" -m pip install --upgrade --no-cache-dir --no-deps 'kokoro-onnx==0.6.1'
"${PYTHON_BIN}" -m pip install --upgrade --no-cache-dir 'tensorrt-cu12==10.11.0.33'
"${PYTHON_BIN}" -c 'import tensorrt; print("tensorrt=" + tensorrt.__version__)'
