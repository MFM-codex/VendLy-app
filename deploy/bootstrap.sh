#!/bin/bash
# One-time server setup for Ubuntu on Oracle Cloud. Runs automatically at first boot.
# Log: /var/log/vendly-bootstrap.log
set -euo pipefail
exec > /var/log/vendly-bootstrap.log 2>&1
export DEBIAN_FRONTEND=noninteractive
REPO=https://github.com/MFM-codex/VendLy-app.git

apt-get update -y
apt-get install -y curl git ca-certificates gnupg openssl debian-keyring debian-archive-keyring apt-transport-https

# 1 GB swap so the small free VM never runs out of memory
if [ ! -f /swapfile ]; then
  fallocate -l 1G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

# Node 22
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs

# Caddy (automatic free HTTPS)
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
apt-get update -y
apt-get install -y caddy

# Open web ports on the server's own firewall (Oracle images block them by default)
iptables -I INPUT 1 -p tcp --dport 443 -j ACCEPT
iptables -I INPUT 1 -p tcp --dport 80 -j ACCEPT
netfilter-persistent save || true

# App user, code, config
id vendly >/dev/null 2>&1 || useradd --system --home /opt/vendly --shell /usr/sbin/nologin vendly
mkdir -p /opt/vendly /var/lib/vendly
[ -d /opt/vendly/app/.git ] || git clone "$REPO" /opt/vendly/app
chown -R vendly:vendly /var/lib/vendly
git -C /opt/vendly/app rev-parse --short HEAD > /var/lib/vendly/commit

cat > /etc/vendly.env <<ENV
MODE=sandbox
PORT=3000
SECRET=$(openssl rand -hex 32)
DB_PATH=/var/lib/vendly/vendly.db
TRUST_PROXY=1
COMMIT_FILE=/var/lib/vendly/commit
ENV
chmod 600 /etc/vendly.env

cat > /etc/systemd/system/vendly.service <<'UNIT'
[Unit]
Description=Vendly API
After=network.target
[Service]
User=vendly
WorkingDirectory=/opt/vendly/app/server
EnvironmentFile=/etc/vendly.env
ExecStart=/usr/bin/node --no-warnings index.js
Restart=always
RestartSec=3
StateDirectory=vendly
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
[Install]
WantedBy=multi-user.target
UNIT

cat > /etc/systemd/system/vendly-update.service <<'UNIT'
[Unit]
Description=Vendly auto-update from GitHub
[Service]
Type=oneshot
ExecStart=/bin/bash /opt/vendly/app/deploy/update.sh
UNIT

cat > /etc/systemd/system/vendly-update.timer <<'UNIT'
[Unit]
Description=Check GitHub for new Vendly code every minute
[Timer]
OnBootSec=2min
OnUnitActiveSec=1min
[Install]
WantedBy=timers.target
UNIT

# Free HTTPS address built from the server's public IP, e.g. 129-146-5-10.sslip.io
IP=$(curl -fsS https://api.ipify.org)
DOMAIN="${IP//./-}.sslip.io"
echo "$DOMAIN" > /etc/vendly.domain
cat > /etc/caddy/Caddyfile <<CADDY
$DOMAIN {
  encode gzip
  reverse_proxy 127.0.0.1:3000
}
CADDY

systemctl daemon-reload
systemctl enable --now vendly vendly-update.timer
systemctl restart caddy
sleep 3
curl -fsS http://127.0.0.1:3000/api/health && echo && echo "READY: https://$DOMAIN"
