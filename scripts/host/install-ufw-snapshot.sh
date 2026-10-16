#!/bin/sh
# Installa (o rimuove con --uninstall) un timer systemd che ogni 5 minuti salva l'output di
# `ufw status verbose` in /opt/gigi-os/data/host/ufw-status.txt (0644), letto da GIGI OS → Rete → Firewall.
# Solo lettura: il timer non modifica alcuna regola. GIGI OS non ottiene privilegi aggiuntivi (D-026).
# Uso: sudo sh scripts/host/install-ufw-snapshot.sh [--uninstall]
set -eu

UNIT=gigi-ufw-snapshot
DIR=/opt/gigi-os/data/host

[ "$(id -u)" -eq 0 ] || { echo "Esegui con sudo" >&2; exit 1; }

if [ "${1:-}" = "--uninstall" ]; then
  systemctl disable --now "$UNIT.timer" 2>/dev/null || true
  rm -f "/etc/systemd/system/$UNIT.service" "/etc/systemd/system/$UNIT.timer"
  systemctl daemon-reload
  rm -f "$DIR/ufw-status.txt"
  echo "Rimosso. La pagina Firewall tornerà a mostrare solo stato del servizio e pacchetti bloccati."
  exit 0
fi

command -v ufw >/dev/null || { echo "ufw non trovato" >&2; exit 1; }

cat > "/etc/systemd/system/$UNIT.service" <<EOF
[Unit]
Description=GIGI OS: istantanea in sola lettura delle regole UFW

[Service]
Type=oneshot
UMask=0022
NoNewPrivileges=yes
PrivateTmp=yes
ProtectHome=yes
ExecStartPre=/usr/bin/install -d -m 0755 $DIR
ExecStart=/bin/sh -c '/usr/sbin/ufw status verbose > $DIR/ufw-status.txt.tmp && mv $DIR/ufw-status.txt.tmp $DIR/ufw-status.txt'
EOF

cat > "/etc/systemd/system/$UNIT.timer" <<EOF
[Unit]
Description=GIGI OS: aggiorna l'istantanea UFW ogni 5 minuti

[Timer]
OnBootSec=1min
OnUnitActiveSec=5min

[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable --now "$UNIT.timer"
systemctl start "$UNIT.service"
echo "Installato. Istantanea: $DIR/ufw-status.txt"
head -4 "$DIR/ufw-status.txt"
