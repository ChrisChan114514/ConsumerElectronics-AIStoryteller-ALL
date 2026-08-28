#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MODEL_URL="${MODEL_URL:-https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.1/kokoro-v1.0.fp16.onnx}"
VOICE_URL="${VOICE_URL:-https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.1/voices-v1.0.bin}"
CURL_CONNECT_TIMEOUT="${CURL_CONNECT_TIMEOUT:-60}"
CURL_MAX_TIME="${CURL_MAX_TIME:-7200}"

download_file() {
  local url="$1"
  local target="$2"
  local expected_size="$3"
  local expected_sha256="$4"
  local partial="${target}.part"
  if [[ -f "${target}" ]] \
    && [[ "$(stat -c %s "${target}")" == "${expected_size}" ]] \
    && [[ "$(sha256sum "${target}" | cut -d ' ' -f 1)" == "${expected_sha256}" ]]; then
    echo "Already present: ${target}"
    return
  fi
  if [[ -f "${partial}" ]] && (( $(stat -c %s "${partial}") > expected_size )); then
    echo "Oversized partial file retained: ${partial}" >&2
    echo "Move it aside before downloading again, or set MODEL_URL to another mirror." >&2
    exit 1
  fi
  curl --fail --location --retry 8 --retry-all-errors \
    --connect-timeout "${CURL_CONNECT_TIMEOUT}" --max-time "${CURL_MAX_TIME}" \
    --continue-at - \
    --output "${partial}" "${url}"
  if [[ "$(stat -c %s "${partial}")" != "${expected_size}" ]]; then
    echo "Unexpected file size for ${partial}; expected ${expected_size}" >&2
    exit 1
  fi
  if [[ "$(sha256sum "${partial}" | cut -d ' ' -f 1)" != "${expected_sha256}" ]]; then
    echo "SHA-256 verification failed for ${partial}" >&2
    exit 1
  fi
  mv "${partial}" "${target}"
}

mkdir -p "${ROOT_DIR}/models" "${ROOT_DIR}/voices"
download_file "${MODEL_URL}" "${ROOT_DIR}/models/kokoro-v1.0.export-v1.1.fp16.onnx" \
  163527961 f3a290d384fbb27966d462905c71a46cef9e5fd00516b40df32a0b4afe77ac96
download_file "${VOICE_URL}" "${ROOT_DIR}/voices/voices-v1.0.bin" \
  28214398 bca610b8308e8d99f32e6fe4197e7ec01679264efed0cac9140fe9c29f1fbf7d
echo "TensorRT FP16 assets are ready under ${ROOT_DIR}"
