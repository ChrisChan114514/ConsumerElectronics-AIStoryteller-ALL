#!/usr/bin/env bash

set -Eeuo pipefail

readonly WEB_APP_NAME="ai-storyteller-webservice"
readonly IOT_APP_NAME="ai-storyteller-iot"
readonly APP_DIR="/home/cc/Desktop/AIStoryteller/WebService"
readonly WEB_APP_ENTRY="${APP_DIR}/src/main.js"
readonly IOT_APP_ENTRY="${APP_DIR}/IoT/main.js"
readonly SERVICE_USER="cc"
readonly SERVICE_HOME="/home/cc"
readonly SERVICE_PORT="2210"
readonly IOT_PORT="2215"

database_required=false

log() {
  printf '[AIStoryteller] %s\n' "$*"
}

fail() {
  printf '[AIStoryteller] ERROR: %s\n' "$*" >&2
  exit 1
}

command_exists() {
  command -v "$1" >/dev/null 2>&1
}

web_health_check() {
  node -e '
    const url = process.argv[1];
    const databaseRequired = process.argv[2] === "true";
    fetch(url, { signal: AbortSignal.timeout(2000) })
      .then(async (response) => {
        if (!response.ok) process.exit(1);
        const body = await response.json();
        process.exit(body.status === "ok" && body.service === "story-machine-web-service" &&
          (!databaseRequired || body.database_ready === true) ? 0 : 1);
      })
      .catch(() => process.exit(1));
  ' "http://127.0.0.1:${SERVICE_PORT}/api/health" "${database_required}"
}

iot_health_check() {
  node --input-type=module -e '
    import mqtt from "mqtt";
    import { iotConfig } from "./IoT/config.js";
    const client = mqtt.connect(`mqtt://127.0.0.1:${process.argv[1]}`, {
      clientId: `SIM-HEALTH${process.pid}`,
      username: iotConfig.mqttUsername,
      password: iotConfig.mqttPassword,
      protocolVersion: 4,
      clean: true,
      reconnectPeriod: 0,
      connectTimeout: 2000
    });
    const timeout = setTimeout(() => { client.end(true); process.exit(1); }, 3000);
    client.once("connect", () => {
      clearTimeout(timeout);
      client.end(false, {}, () => process.exit(0));
    });
    client.once("error", () => {
      clearTimeout(timeout);
      client.end(true);
      process.exit(1);
    });
  ' "${IOT_PORT}"
}

show_failure_diagnostics() {
  pm2 describe "${WEB_APP_NAME}" || true
  pm2 describe "${IOT_APP_NAME}" || true
  pm2 logs "${WEB_APP_NAME}" --lines 80 --nostream || true
  pm2 logs "${IOT_APP_NAME}" --lines 80 --nostream || true
  if command_exists ss; then
    log "TCP listeners related to ports ${SERVICE_PORT} and ${IOT_PORT}:"
    ss -ltnp 2>/dev/null | grep -E "(^|:)(${SERVICE_PORT}|${IOT_PORT})([[:space:]]|$)" || true
  fi
}

[[ "$(uname -s)" == "Linux" ]] || fail "This script only supports Linux."
[[ "$(id -un)" == "${SERVICE_USER}" ]] || fail "Run this script as user ${SERVICE_USER}, not root."
[[ -d "${APP_DIR}" ]] || fail "Application directory does not exist: ${APP_DIR}"
[[ -f "${WEB_APP_ENTRY}" ]] || fail "Application entry does not exist: ${WEB_APP_ENTRY}"
[[ -f "${IOT_APP_ENTRY}" ]] || fail "IoT entry does not exist: ${IOT_APP_ENTRY}"
[[ -f "${APP_DIR}/package.json" ]] || fail "package.json is missing from ${APP_DIR}"

if [[ "${MYSQL_ENABLED:-false}" == "true" ]] || [[ -f "${APP_DIR}/.env" ]] && grep -Eq '^[[:space:]]*MYSQL_ENABLED=true([[:space:]]|$)' "${APP_DIR}/.env"; then
  database_required=true
fi

command_exists node || fail "Node.js is not installed. Install Node.js 22 or newer first."
command_exists npm || fail "npm is not installed. Install Node.js 22 or newer first."
command_exists systemctl || fail "systemd is required, but systemctl was not found."
command_exists sudo || fail "sudo is required to register the PM2 systemd service."

node_major="$(node -p 'Number(process.versions.node.split(".")[0])')"
[[ "${node_major}" -ge 22 ]] || fail "Node.js 22 or newer is required; found $(node --version)."

if ! command_exists pm2; then
  log "PM2 was not found; installing it for user ${SERVICE_USER}..."
  if ! npm install --global pm2; then
    log "User-level installation failed; retrying with sudo..."
    sudo env "PATH=${PATH}" npm install --global pm2
  fi
  hash -r
fi
command_exists pm2 || fail "PM2 installation did not add pm2 to PATH."

if [[ -n "${LLM_API_KEY:-}" ]]; then
  log "Using LLM_API_KEY from the current environment."
elif grep -Eq '^(LLM_API_KEY=)?sk-[A-Za-z0-9_-]{20,}$' "${APP_DIR}/APIkey/DeepseekAPI.txt" 2>/dev/null; then
  chmod 600 "${APP_DIR}/APIkey/DeepseekAPI.txt"
else
  fail "No API key found. Add it to APIkey/DeepseekAPI.txt or export LLM_API_KEY."
fi

if [[ -n "${TTS_API_KEY:-}" ]]; then
  log "Using TTS_API_KEY from the current environment."
elif grep -Eq '^[A-Za-z0-9_-]{20,}$' "${APP_DIR}/APIkey/Doubao_TTS.txt" 2>/dev/null; then
  chmod 600 "${APP_DIR}/APIkey/Doubao_TTS.txt"
else
  fail "No Doubao TTS key found. Add it to APIkey/Doubao_TTS.txt or export TTS_API_KEY."
fi

cd "${APP_DIR}"

[[ -f "${APP_DIR}/package-lock.json" ]] || fail "package-lock.json is missing from ${APP_DIR}"
log "Installing production dependencies from package-lock.json..."
npm ci --omit=dev

if [[ "${database_required}" == "true" ]]; then
  log "Checking the configured MySQL listener before starting PM2..."
  if ! node --input-type=module -e '
    import net from "node:net";
    import { config } from "./src/config.js";
    const socket = net.createConnection({ host: config.database.host, port: config.database.port });
    socket.setTimeout(3000);
    socket.once("connect", () => { socket.destroy(); process.exit(0); });
    socket.once("timeout", () => { socket.destroy(); process.exit(1); });
    socket.once("error", () => process.exit(1));
  '; then
    fail "MySQL is not accepting connections on the configured host/port. Run bash ${APP_DIR}/bash/setup_mysql.sh first."
  fi
fi

export NODE_ENV="production"
export HOST="0.0.0.0"
export PORT="${SERVICE_PORT}"
export IOT_HOST="0.0.0.0"
export IOT_MQTT_PORT="${IOT_PORT}"

node_bin="$(command -v node)"
pm2_bin="$(command -v pm2)"

for app_name in "${WEB_APP_NAME}" "${IOT_APP_NAME}"; do
  if pm2 describe "${app_name}" >/dev/null 2>&1; then
    log "Removing the previous PM2 definition: ${app_name}"
    pm2 delete "${app_name}"
  fi
done

log "Starting WebService on HTTP port ${SERVICE_PORT}..."
pm2 start "${WEB_APP_ENTRY}" \
  --name "${WEB_APP_NAME}" \
  --cwd "${APP_DIR}" \
  --interpreter "${node_bin}" \
  --time \
  --max-memory-restart 300M

log "Starting IoT MQTT service on port ${IOT_PORT}..."
pm2 start "${IOT_APP_ENTRY}" \
  --name "${IOT_APP_NAME}" \
  --cwd "${APP_DIR}" \
  --interpreter "${node_bin}" \
  --time \
  --max-memory-restart 300M

log "Waiting for the HTTP health check on port ${SERVICE_PORT}..."
health_ready=false
for _attempt in {1..20}; do
  if web_health_check; then
    health_ready=true
    break
  fi
  sleep 1
done

if [[ "${health_ready}" != "true" ]]; then
  show_failure_diagnostics
  fail "Service did not pass its HTTP health check on 127.0.0.1:${SERVICE_PORT}. See the diagnostics above."
fi

log "HTTP health check passed."
log "Waiting for an authenticated MQTT handshake on port ${IOT_PORT}..."
iot_ready=false
for _attempt in {1..20}; do
  if iot_health_check; then
    iot_ready=true
    break
  fi
  sleep 1
done

if [[ "${iot_ready}" != "true" ]]; then
  show_failure_diagnostics
  fail "IoT service did not pass its MQTT check on 127.0.0.1:${IOT_PORT}. See the diagnostics above."
fi

log "MQTT health check passed."
log "Saving the PM2 process list..."
pm2 save --force

log "Registering PM2 with systemd (sudo may ask for the ${SERVICE_USER} password)..."
sudo env "PATH=${PATH}" "${pm2_bin}" startup systemd \
  -u "${SERVICE_USER}" \
  --hp "${SERVICE_HOME}"

sudo systemctl enable "pm2-${SERVICE_USER}.service" >/dev/null

log "Service is listening locally: http://127.0.0.1:${SERVICE_PORT}"
log "Console: http://<server-ip>:${SERVICE_PORT}"
log "Health check: http://127.0.0.1:${SERVICE_PORT}/api/health"
log "MQTT endpoint: mqtt://<server-ip>:${IOT_PORT}"
pm2 status
