#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HF_ENDPOINT="${HF_ENDPOINT:-https://hf-mirror.com}"
REPO="${HF_REPO:-hexgrad/Kokoro-82M}"

download_file() {
  local relative_path="$1"
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

  curl --fail --location --retry 8 --retry-all-errors \
    --connect-timeout 60 --max-time 7200 --continue-at - \
    --output "${partial}" \
    "${HF_ENDPOINT}/${REPO}/resolve/main/${relative_path}"

  [[ "$(stat -c %s "${partial}")" == "${expected_size}" ]] || {
    echo "Unexpected size for ${partial}; expected ${expected_size}" >&2
    exit 1
  }
  [[ "$(sha256sum "${partial}" | cut -d ' ' -f 1)" == "${expected_sha256}" ]] || {
    echo "SHA-256 verification failed for ${partial}" >&2
    exit 1
  }
  mv "${partial}" "${target}"
}

mkdir -p "${ROOT_DIR}/checkpoints"
download_file config.json "${ROOT_DIR}/checkpoints/config.json" \
  2351 5abb01e2403b072bf03d04fde160443e209d7a0dad49a423be15196b9b43c17f
download_file kokoro-v1_0.pth "${ROOT_DIR}/checkpoints/kokoro-v1_0.pth" \
  327212226 496dba118d1a58f5f3db2efc88dbdc216e0483fc89fe6e47ee1f2c53f18ad1e4
echo "PyTorch export assets are ready under ${ROOT_DIR}/checkpoints"
