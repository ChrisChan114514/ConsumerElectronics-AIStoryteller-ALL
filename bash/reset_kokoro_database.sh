#!/usr/bin/env bash

set -Eeuo pipefail

readonly APP_DIR="/home/cc/Desktop/AIStoryteller/WebService"
readonly SCHEMA_FILE="${APP_DIR}/database/schema.sql"
readonly TARGET_DATABASE="kokoro_TensorRT_FP16"
readonly OLD_DATABASE="story_machine"

if [[ "${1:-}" != "--yes" ]]; then
  printf 'This deletes database %s and removes the old %s database.\n' "${OLD_DATABASE}" "${OLD_DATABASE}"
  printf 'Run: bash %s --yes\n' "$0"
  exit 2
fi
[[ "$(id -un)" == "cc" ]] || { echo 'Run this script as user cc.' >&2; exit 1; }
[[ -f "${APP_DIR}/.env" && -f "${SCHEMA_FILE}" ]] || { echo 'WebService .env or schema is missing.' >&2; exit 1; }

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
[[ "${configured_db}" == "${TARGET_DATABASE}" ]] || { echo "MYSQL_DATABASE must already be ${TARGET_DATABASE}; found ${configured_db}." >&2; exit 1; }
[[ "${mysql_host}" == '127.0.0.1' || "${mysql_host}" == 'localhost' ]] || { echo 'Only local MySQL is supported.' >&2; exit 1; }
[[ -n "${mysql_password}" ]] || { echo 'MYSQL_PASSWORD is empty.' >&2; exit 1; }

echo "Creating clean ${TARGET_DATABASE} and importing schema..."
sudo mariadb --protocol=SOCKET <<SQL
DROP DATABASE IF EXISTS \`${TARGET_DATABASE}\`;
CREATE DATABASE \`${TARGET_DATABASE}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS '${mysql_user}'@'localhost' IDENTIFIED BY '${mysql_password//\'/\'\'}';
ALTER USER '${mysql_user}'@'localhost' IDENTIFIED BY '${mysql_password//\'/\'\'}';
GRANT ALL PRIVILEGES ON \`${TARGET_DATABASE}\`.* TO '${mysql_user}'@'localhost';
CREATE USER IF NOT EXISTS '${mysql_user}'@'127.0.0.1' IDENTIFIED BY '${mysql_password//\'/\'\'}';
ALTER USER '${mysql_user}'@'127.0.0.1' IDENTIFIED BY '${mysql_password//\'/\'\'}';
GRANT ALL PRIVILEGES ON \`${TARGET_DATABASE}\`.* TO '${mysql_user}'@'127.0.0.1';
FLUSH PRIVILEGES;
SQL

if command -v mariadb >/dev/null 2>&1; then client=mariadb; else client=mysql; fi
MYSQL_PWD="${mysql_password}" "${client}" --protocol=TCP --host="${mysql_host}" --port="${mysql_port}" \
  --user="${mysql_user}" "${TARGET_DATABASE}" < "${SCHEMA_FILE}"

table_count="$(MYSQL_PWD="${mysql_password}" "${client}" --protocol=TCP --host="${mysql_host}" --port="${mysql_port}" \
  --user="${mysql_user}" "${TARGET_DATABASE}" --batch --skip-column-names \
  --execute="SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = '${TARGET_DATABASE}' AND TABLE_NAME IN ('story_pools','story_clients','stories','story_audio','story_history');")"
[[ "${table_count}" == '5' ]] || { echo "Expected 5 tables, found ${table_count}." >&2; exit 1; }

echo "Dropping old ${OLD_DATABASE} after the new schema was verified..."
sudo mariadb --protocol=SOCKET -e "DROP DATABASE IF EXISTS \`${OLD_DATABASE}\`;"
echo "Database ${TARGET_DATABASE} is ready and empty; old ${OLD_DATABASE} was removed."
