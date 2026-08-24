# Linux PM2 deployment scripts

These scripts are intended for the remote Linux host only. The fixed deployment directory is:

```text
/home/cc/Desktop/AIStoryteller/WebService
```

Run them as Linux user `cc`, not as `root`.

Before starting, put the service credentials in `APIkey/DeepseekAPI.txt` and `APIkey/Doubao_TTS.txt`. After a remote `git pull`, the startup script reads those files directly.

## Set up MySQL on port 2211

The application setting `MYSQL_PORT=2211` does not change the MySQL server itself. Run the setup script once before starting PM2:

```bash
cd /home/cc/Desktop/AIStoryteller/WebService
chmod +x bash/setup_mysql.sh bash/start_pm2.sh bash/stop_pm2.sh
bash bash/setup_mysql.sh
```

The script supports both Arch Linux and Ubuntu/Debian. On Arch it installs MariaDB with `pacman`, initializes `/var/lib/mysql`, writes the port override under `/etc/my.cnf.d`, and enables `mariadb.service`. On Ubuntu/Debian it installs MySQL with `apt-get` and writes under `/etc/mysql/mysql.conf.d`. Both paths listen only on `127.0.0.1:2211`, create the configured database/user and all five application tables, update `.env`, and verify an actual TCP login. The script reads the database name, user, and password from `.env`, falling back to `.env.example` when `.env` does not exist.

The PM2 startup script now checks the MySQL TCP listener before replacing the running application. When MySQL is enabled but unavailable, it stops with an instruction to run `setup_mysql.sh`.

## Start and enable at boot

```bash
cd /home/cc/Desktop/AIStoryteller/WebService
chmod +x bash/start_pm2.sh bash/stop_pm2.sh
./bash/start_pm2.sh
```

The startup script checks Node.js 22+, installs locked production dependencies and PM2 for the current user when missing, starts the service on port `2210`, and verifies the HTTP health endpoint before saving the PM2 process list and registering `pm2-cc.service` with systemd. `sudo` is required for the systemd registration step. On a failed health check it prints recent PM2 logs and the local TCP listener state.

## Stop and remove from startup restoration

```bash
cd /home/cc/Desktop/AIStoryteller/WebService
./bash/stop_pm2.sh
```

The stop script removes only `ai-storyteller-webservice` from PM2 and saves the updated process list. It leaves the shared PM2 systemd unit enabled so other PM2 applications are not affected.

## Useful commands

```bash
pm2 status ai-storyteller-webservice
pm2 logs ai-storyteller-webservice
curl http://127.0.0.1:2210/api/health
systemctl status pm2-cc.service
```

If the local health check succeeds but another computer cannot open `http://<server-ip>:2210`, check the Linux firewall and any router or cloud security-group rules for inbound TCP port `2210`.
