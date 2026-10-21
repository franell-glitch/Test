#!/usr/bin/env bash
# Installiert bzw. aktualisiert die Zeiterfassung auf einem Ubuntu-Server
# (getestet für Oracle Cloud "Always Free", Ubuntu 22.04/24.04, x86 und ARM).
#
# Aufruf auf dem Server:
#   curl -fsSL https://raw.githubusercontent.com/franell-glitch/Test/HEAD/deploy/install.sh | sudo bash
# Mit eigener Domain (DNS-A-Eintrag muss auf die Server-IP zeigen):
#   curl -fsSL .../install.sh | sudo DOMAIN=zeit.example.de bash
#
# Als Oracle-Startskript (Cloud-Init) siehe deploy/oracle-startskript.sh.
#
# Erneutes Ausführen aktualisiert die App auf den neuesten Stand; Daten und Passwort bleiben erhalten.
set -euo pipefail

APP=zeiterfassung
REPO_URL="${REPO_URL:-https://github.com/franell-glitch/Test.git}"
BRANCH="${BRANCH:-}"
APP_DIR=/opt/apps/$APP
DATA_DIR=/var/lib/$APP
BACKUP_DIR=/var/backups/$APP
ENV_FILE=/etc/$APP.env
PORT="${PORT:-3000}"

log() { echo -e "\n\033[1;34m==> $*\033[0m"; }

# Alles in einer Funktion, damit "curl | bash" das Skript vollständig liest, bevor es läuft
main() {
if [ "$(id -u)" -ne 0 ]; then
  echo "Bitte mit sudo ausführen." >&2
  exit 1
fi
export DEBIAN_FRONTEND=noninteractive
# Beim ersten Systemstart laufen oft noch automatische Updates – dann auf die apt-Sperre warten
apt-get() { command apt-get -o DPkg::Lock::Timeout=600 "$@"; }
for _ in $(seq 120); do
  pgrep -x 'apt|apt-get|dpkg|unattended-upgr' >/dev/null || break
  echo "Warte auf laufende System-Updates …"
  sleep 5
done

log "Systempakete installieren"
apt-get update -q
apt-get install -y -q curl git sqlite3 unzip ca-certificates gnupg debian-keyring debian-archive-keyring apt-transport-https iptables-persistent

if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  log "Node.js 22 installieren"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y -q nodejs
fi

if ! command -v caddy >/dev/null; then
  log "Caddy (Webserver mit automatischem HTTPS) installieren"
  if curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg &&
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list; then
    apt-get update -q
  else
    # Fallback: Caddy aus den Ubuntu-Paketquellen
    rm -f /etc/apt/sources.list.d/caddy-stable.list
  fi
  apt-get install -y -q caddy
fi

if ! command -v rclone >/dev/null; then
  log "rclone (für die Sicherung nach OneDrive) installieren"
  curl -fsSL https://rclone.org/install.sh | bash || apt-get install -y -q rclone
fi

log "Benutzer und Verzeichnisse anlegen"
id -u $APP >/dev/null 2>&1 || useradd --system --home-dir $DATA_DIR --shell /usr/sbin/nologin $APP
mkdir -p /opt/apps $DATA_DIR $BACKUP_DIR
chown -R $APP:$APP $DATA_DIR
chmod 750 $DATA_DIR $BACKUP_DIR

log "Programmcode holen"
if [ -d $APP_DIR/.git ]; then
  git -C $APP_DIR fetch -q origin
  git -C $APP_DIR reset -q --hard "origin/${BRANCH:-HEAD}"
else
  git clone -q ${BRANCH:+--branch "$BRANCH"} "$REPO_URL" $APP_DIR
fi
cd $APP_DIR
npm ci --omit=dev --no-audit --no-fund

if [ ! -f $ENV_FILE ]; then
  log "Konfiguration anlegen"
  ADMIN_PASSWORD="${ADMIN_PASSWORD:-$(node -e "process.stdout.write(require('crypto').randomBytes(12).toString('base64url'))")}"
  cat > $ENV_FILE <<EOF
ADMIN_PASSWORD=$ADMIN_PASSWORD
HOST=127.0.0.1
PORT=$PORT
DB_PATH=$DATA_DIR/$APP.db
NODE_ENV=production
EOF
  NEW_PASSWORD=1
fi
chmod 600 $ENV_FILE

log "Systemdienst einrichten"
cat > /etc/systemd/system/$APP.service <<EOF
[Unit]
Description=Zeiterfassung mit Gesichtserkennung
After=network.target

[Service]
User=$APP
Group=$APP
WorkingDirectory=$APP_DIR
EnvironmentFile=$ENV_FILE
ExecStart=$(command -v node) --no-warnings=ExperimentalWarning server.js
Restart=always
RestartSec=3
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=$DATA_DIR

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable -q $APP
systemctl restart $APP

log "HTTPS einrichten"
if [ -z "${DOMAIN:-}" ]; then
  if [ -f /etc/caddy/sites/$APP.caddy ]; then
    DOMAIN="$(head -n1 /etc/caddy/sites/$APP.caddy | cut -d' ' -f1)"
  else
    # Ohne eigene Domain: kostenlose Adresse über sslip.io, die auf die Server-IP zeigt
    PUBLIC_IP="$(curl -4fsS https://ifconfig.me || curl -4fsS https://api.ipify.org)"
    DOMAIN="zeit.${PUBLIC_IP//./-}.sslip.io"
  fi
fi
mkdir -p /etc/caddy/sites
# Jede App bekommt eine eigene Datei in /etc/caddy/sites – so passen später weitere Programme auf denselben Server
if ! grep -q 'import /etc/caddy/sites/\*.caddy' /etc/caddy/Caddyfile 2>/dev/null; then
  echo 'import /etc/caddy/sites/*.caddy' > /etc/caddy/Caddyfile
fi
cat > /etc/caddy/sites/$APP.caddy <<EOF
$DOMAIN {
	encode gzip
	reverse_proxy 127.0.0.1:$PORT
}
EOF
systemctl enable -q caddy
systemctl reload caddy || systemctl restart caddy

log "Firewall öffnen (Ports 80 und 443)"
# Oracle-Ubuntu-Images blockieren alles außer SSH per iptables
for p in 80 443; do
  iptables -C INPUT -p tcp --dport $p -j ACCEPT 2>/dev/null || iptables -I INPUT -p tcp --dport $p -j ACCEPT
done
netfilter-persistent save >/dev/null

log "Tägliches Backup einrichten"
cat > /etc/cron.daily/$APP-backup <<EOF
#!/bin/sh
# Sichert die Datenbank täglich und behält die letzten 30 Sicherungen
[ -f $DATA_DIR/$APP.db ] || exit 0
sqlite3 $DATA_DIR/$APP.db ".backup '$BACKUP_DIR/$APP-\$(date +%F).db'"
find $BACKUP_DIR -name '$APP-*.db' -mtime +30 -delete
EOF
chmod 755 /etc/cron.daily/$APP-backup

sleep 2
if systemctl is-active -q $APP; then
  log "Fertig!"
else
  echo "Der Dienst läuft nicht. Fehler anzeigen mit: journalctl -u $APP -n 50" >&2
  exit 1
fi

cat <<EOF

  Terminal:    https://$DOMAIN/kiosk
  Verwaltung:  https://$DOMAIN/admin
EOF
if [ -n "${NEW_PASSWORD:-}" ]; then
  echo "  Admin-Passwort: $ADMIN_PASSWORD   (bitte notieren!)"
else
  echo "  Admin-Passwort: unverändert (steht in $ENV_FILE)"
fi
cat <<EOF

  Hinweis: Das HTTPS-Zertifikat wird beim ersten Aufruf automatisch geholt (kann ~1 Minute dauern).
  Falls die Seite nicht erreichbar ist: In der Oracle-Konsole unter
  Networking > Virtual Cloud Networks > Subnet > Security List die Ports 80 und 443 freigeben.
EOF
}

main "$@"
