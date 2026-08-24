#!/usr/bin/env bash

set -Eeuo pipefail

readonly APP_NAME="ai-storyteller-webservice"
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

if pm2 describe "${APP_NAME}" >/dev/null 2>&1; then
  log "Stopping and removing ${APP_NAME} from PM2..."
  pm2 delete "${APP_NAME}"
else
  log "${APP_NAME} is not registered in PM2; nothing to stop."
fi

# Persist the removal so pm2 resurrect will not restart this application.
pm2 save --force

log "Service is stopped and removed from the saved PM2 process list."
log "The shared PM2 systemd service remains enabled for other PM2 applications."

