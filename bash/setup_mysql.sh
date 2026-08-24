#!/usr/bin/env bash

set -Eeuo pipefail

readonly APP_DIR="/home/cc/Desktop/AIStoryteller/WebService"
readonly SCHEMA_FILE="${APP_DIR}/database/schema.sql"
readonly SERVICE_USER="cc"
readonly DEFAULT_MYSQL_PORT="2211"

log() {
  printf '[AIStoryteller MySQL] %s\n' "$*"
}

fail() {
  printf '[AIStoryteller MySQL] ERROR: %s\n' "$*" >&2
  exit 1
}

env_value() {
  local name="$1"
  local fallback="$2"
  local value=""
  if [[ -f "${APP_DIR}/.env" ]]; then
    value="$(sed -nE "s/^[[:space:]]*${name}[[:space:]]*=(.*)$/\1/p" "${APP_DIR}/.env" | tail -n 1 | tr -d '\r')"
  fi
  if [[ -z "${value}" && -f "${APP_DIR}/.env.example" ]]; then
    value="$(sed -nE "s/^[[:space:]]*${name}[[:space:]]*=(.*)$/\1/p" "${APP_DIR}/.env.example" | tail -n 1 | tr -d '\r')"
  fi
  value="${value#\"}"
  value="${value%\"}"
  value="${value#\'}"
  value="${value%\'}"
  printf '%s' "${value:-${fallback}}"
}

set_env_value() {
  local name="$1"
  local value="$2"
  local escaped_value="${value//\\/\\\\}"
  escaped_value="${escaped_value//&/\\&}"
  escaped_value="${escaped_value//|/\\|}"
  if grep -Eq "^[[:space:]]*${name}=" "${APP_DIR}/.env"; then
    sed -i -E "s|^[[:space:]]*${name}=.*$|${name}=${escaped_value}|" "${APP_DIR}/.env"
  else
    printf '\n%s=%s\n' "${name}" "${value}" >> "${APP_DIR}/.env"
  fi
}

[[ "$(uname -s)" == "Linux" ]] || fail "This script only supports Linux."
[[ "$(id -un)" == "${SERVICE_USER}" ]] || fail "Run this script as user ${SERVICE_USER}, not root."
[[ -d "${APP_DIR}" ]] || fail "Application directory does not exist: ${APP_DIR}"
[[ -f "${SCHEMA_FILE}" ]] || fail "Database schema does not exist: ${SCHEMA_FILE}"
command -v sudo >/dev/null 2>&1 || fail "sudo is required to install and configure MySQL."
command -v systemctl >/dev/null 2>&1 || fail "systemd is required."

mysql_host="$(env_value MYSQL_HOST 127.0.0.1)"
mysql_port="$(env_value MYSQL_PORT "${DEFAULT_MYSQL_PORT}")"
mysql_user="$(env_value MYSQL_USER story_machine)"
mysql_password="$(env_value MYSQL_PASSWORD '')"
mysql_database="$(env_value MYSQL_DATABASE story_machine)"

[[ "${mysql_host}" == "127.0.0.1" || "${mysql_host}" == "localhost" ]] || \
  fail "This setup script manages a local database only; MYSQL_HOST is ${mysql_host}."
[[ "${mysql_port}" =~ ^[0-9]+$ ]] && (( mysql_port >= 1 && mysql_port <= 65535 )) || \
  fail "MYSQL_PORT must be between 1 and 65535."
[[ "${mysql_user}" =~ ^[A-Za-z0-9_]+$ ]] || fail "MYSQL_USER may contain only letters, numbers, and underscores."
[[ "${mysql_database}" =~ ^[A-Za-z0-9_]+$ ]] || fail "MYSQL_DATABASE may contain only letters, numbers, and underscores."
[[ -n "${mysql_password}" && "${mysql_password}" != "CHANGE_THIS_PASSWORD" ]] || \
  fail "Set a real MYSQL_PASSWORD in ${APP_DIR}/.env or .env.example first."

if command -v pacman >/dev/null 2>&1; then
  database_family="mariadb"
  mysql_service="mariadb.service"
  mysql_config_directory="/etc/my.cnf.d"
  mysql_override_file="${mysql_config_directory}/99-ai-storyteller.cnf"

  if ! command -v mariadb >/dev/null 2>&1 || ! command -v mariadbd >/dev/null 2>&1; then
    log "Installing MariaDB with pacman..."
    sudo pacman -Syu --needed --noconfirm mariadb
  fi

  sudo install -d -m 0755 "${mysql_config_directory}"
  if ! sudo test -e "/var/lib/mysql/mysql/global_priv.MAI" && \
      ! sudo test -e "/var/lib/mysql/mysql/user.MYD"; then
    log "Initializing the Arch Linux MariaDB data directory..."
    sudo mariadb-install-db --user=mysql --basedir=/usr --datadir=/var/lib/mysql
  fi
elif command -v apt-get >/dev/null 2>&1; then
  database_family="mysql"
  mysql_service="mysql.service"
  mysql_config_directory="/etc/mysql/mysql.conf.d"
  mysql_override_file="${mysql_config_directory}/99-ai-storyteller.cnf"

  if ! command -v mysql >/dev/null 2>&1 || ! command -v mysqld >/dev/null 2>&1; then
    log "Installing MySQL server with apt-get..."
    sudo apt-get update
    sudo env DEBIAN_FRONTEND=noninteractive apt-get install -y mysql-server
  fi
  [[ -d "${mysql_config_directory}" ]] || fail "MySQL config directory is missing: ${mysql_config_directory}"
else
  fail "Unsupported Linux distribution. Install MySQL/MariaDB manually, then configure it on port ${mysql_port}."
fi

temporary_config="$(mktemp)"
trap 'rm -f "${temporary_config}"' EXIT
printf '[mysqld]\nport=%s\nbind-address=127.0.0.1\n' "${mysql_port}" > "${temporary_config}"
log "Configuring MySQL to listen on 127.0.0.1:${mysql_port}..."
sudo install -m 0644 "${temporary_config}" "${mysql_override_file}"

[[ "$(systemctl show "${mysql_service}" --property=LoadState --value 2>/dev/null)" == "loaded" ]] || \
  fail "Database systemd unit is missing: ${mysql_service}"
sudo systemctl enable "${mysql_service}" >/dev/null
sudo systemctl restart "${mysql_service}"

listener_ready=false
for _attempt in {1..30}; do
  if command -v ss >/dev/null 2>&1 && ss -ltn 2>/dev/null | grep -Eq "(^|:)${mysql_port}([[:space:]]|$)"; then
    listener_ready=true
    break
  fi
  sleep 1
done
[[ "${listener_ready}" == "true" ]] || {
  sudo systemctl status "${mysql_service}" --no-pager || true
  sudo journalctl -u "${mysql_service}" -n 80 --no-pager || true
  fail "MySQL did not start listening on port ${mysql_port}."
}

escaped_password="${mysql_password//\\/\\\\}"
escaped_password="${escaped_password//\'/\'\'}"
log "Creating database and application account..."
if [[ "${database_family}" == "mariadb" ]]; then
  administrator_command=(sudo mariadb --protocol=SOCKET)
else
  administrator_command=(sudo mysql --protocol=SOCKET)
fi
"${administrator_command[@]}" <<SQL
CREATE DATABASE IF NOT EXISTS \`${mysql_database}\`
  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS '${mysql_user}'@'localhost' IDENTIFIED BY '${escaped_password}';
ALTER USER '${mysql_user}'@'localhost' IDENTIFIED BY '${escaped_password}';
GRANT ALL PRIVILEGES ON \`${mysql_database}\`.* TO '${mysql_user}'@'localhost';
CREATE USER IF NOT EXISTS '${mysql_user}'@'127.0.0.1' IDENTIFIED BY '${escaped_password}';
ALTER USER '${mysql_user}'@'127.0.0.1' IDENTIFIED BY '${escaped_password}';
GRANT ALL PRIVILEGES ON \`${mysql_database}\`.* TO '${mysql_user}'@'127.0.0.1';
FLUSH PRIVILEGES;
SQL

if [[ ! -f "${APP_DIR}/.env" ]]; then
  cp "${APP_DIR}/.env.example" "${APP_DIR}/.env"
fi
chmod 600 "${APP_DIR}/.env"
set_env_value MYSQL_ENABLED true
set_env_value MYSQL_HOST 127.0.0.1
set_env_value MYSQL_PORT "${mysql_port}"
set_env_value MYSQL_USER "${mysql_user}"
set_env_value MYSQL_PASSWORD "${mysql_password}"
set_env_value MYSQL_DATABASE "${mysql_database}"

log "Verifying the application login..."
if command -v mariadb >/dev/null 2>&1; then
  client_command="mariadb"
else
  client_command="mysql"
fi
MYSQL_PWD="${mysql_password}" "${client_command}" \
  --protocol=TCP --host=127.0.0.1 --port="${mysql_port}" \
  --user="${mysql_user}" "${mysql_database}" \
  --execute='SELECT VERSION() AS mysql_version, DATABASE() AS database_name;'

log "Creating and updating the AI Storyteller tables..."
MYSQL_PWD="${mysql_password}" "${client_command}" \
  --protocol=TCP --host=127.0.0.1 --port="${mysql_port}" \
  --user="${mysql_user}" "${mysql_database}" < "${SCHEMA_FILE}"

table_count="$(MYSQL_PWD="${mysql_password}" "${client_command}" \
  --protocol=TCP --host=127.0.0.1 --port="${mysql_port}" \
  --user="${mysql_user}" "${mysql_database}" --batch --skip-column-names \
  --execute="SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN ('story_pools', 'story_clients', 'stories', 'story_audio', 'story_history');")"
[[ "${table_count}" == "5" ]] || fail "Expected 5 application tables, but found ${table_count}."

log "MySQL is ready on 127.0.0.1:${mysql_port}."
log "Database ${mysql_database} contains all 5 AI Storyteller tables."
log "Now run: bash ${APP_DIR}/bash/start_pm2.sh"
