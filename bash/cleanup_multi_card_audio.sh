#!/usr/bin/env bash

set -Eeuo pipefail

readonly APP_DIR="/home/cc/Desktop/AIStoryteller/WebService"
readonly TARGET_DATABASE="kokoro_TensorRT_FP16"

if [[ "${1:-}" != "--yes" ]]; then
  printf 'This permanently deletes cached audio for multi-card stories from %s.\n' "${TARGET_DATABASE}"
  printf 'Run: bash %s --yes\n' "$0"
  exit 2
fi
[[ "$(id -un)" == "cc" ]] || { echo 'Run this script as user cc.' >&2; exit 1; }
[[ -f "${APP_DIR}/.env" ]] || { echo 'WebService .env is missing.' >&2; exit 1; }

env_value() {
  local name="$1" fallback="$2" value
  value="$(sed -nE "s/^[[:space:]]*${name}[[:space:]]*=(.*)$/\1/p" "${APP_DIR}/.env" | tail -n 1 | tr -d '\r')"
  value="${value#\"}"; value="${value%\"}"; value="${value#\'}"; value="${value%\'}"
  printf '%s' "${value:-${fallback}}"
}

mysql_host="$(env_value MYSQL_HOST 127.0.0.1)"
mysql_port="$(env_value MYSQL_PORT 2211)"
mysql_user="$(env_value MYSQL_USER story_machine)"
mysql_password="$(env_value MYSQL_PASSWORD '')"
configured_db="$(env_value MYSQL_DATABASE '')"
[[ "${configured_db}" == "${TARGET_DATABASE}" ]] || { echo "MYSQL_DATABASE must be ${TARGET_DATABASE}; found ${configured_db}." >&2; exit 1; }
[[ -n "${mysql_password}" ]] || { echo 'MYSQL_PASSWORD is empty.' >&2; exit 1; }
[[ "${mysql_host}" == '127.0.0.1' || "${mysql_host}" == 'localhost' ]] || { echo 'Only local MySQL is supported.' >&2; exit 1; }

if command -v mariadb >/dev/null 2>&1; then client=mariadb; else client=mysql; fi
MYSQL_PWD="${mysql_password}" "${client}" --protocol=TCP --host="${mysql_host}" --port="${mysql_port}" \
  --user="${mysql_user}" "${TARGET_DATABASE}" \
  --execute="DELETE a FROM story_audio a JOIN stories s ON s.story_id = a.story_id WHERE JSON_LENGTH(s.card_ids) > 1;"

audio_cache="${APP_DIR}/IoT/generated-audio"
removed_files=0
if [[ -d "${audio_cache}" ]]; then
  removed_files="$(find "${audio_cache}" -maxdepth 1 -type f \( -name '*.wav' -o -name '*.wav.json' \) -print -delete | wc -l)"
fi
echo "Multi-card cached audio was removed from ${TARGET_DATABASE}; stories and playback history were preserved."
echo "Removed ${removed_files} obsolete IoT WAV cache files; new device artifacts are MP3 only."
