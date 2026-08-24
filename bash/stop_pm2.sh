#!/usr/bin/env bash

set -Eeuo pipefail

readonly APP_NAMES=("ai-storyteller-webservice" "ai-storyteller-iot")
readonly SERVICE_USER="cc"

log() {
  printf '[AIStoryteller] %s\n' "$*"
}

fail() {
  printf '[AIStoryteller] ERROR: %s\n' "$*" >&2
  exit 1
}

[[ "$(uname -s)" == "Linux" ]] || fail "This script only supports Linux."
[[ "$(id -un)" == "${SERVICE_USER}" ]] || fail "Run this script as user ${SERVICE_USER}, not root."
command -v pm2 >/dev/null 2>&1 || fail "PM2 was not found in PATH."

for app_name in "${APP_NAMES[@]}"; do
  if pm2 describe "${app_name}" >/dev/null 2>&1; then
    log "Stopping and removing ${app_name} from PM2..."
    pm2 delete "${app_name}"
  else
    log "${app_name} is not registered in PM2; nothing to stop."
  fi
done

# Persist the removal so pm2 resurrect will not restart this application.
pm2 save --force

log "WebService and IoT service are stopped and removed from the saved PM2 process list."
log "The shared PM2 systemd service remains enabled for other PM2 applications."

