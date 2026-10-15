#!/usr/bin/env sh
# Genera (solo se mancanti) la chiave master del vault e il certificato TLS locale.
# Idempotente: non sovrascrive mai segreti esistenti (perderebbe l'accesso alle credenziali cifrate).
set -eu
cd "$(dirname "$0")/.."
IP="${GIGI_BIND:-192.168.222.200}"
UIDGID="${GIGI_UIDGID:-1000:1000}"
mkdir -p secrets data
chmod 700 secrets data

if [ ! -f secrets/master.key ]; then
  openssl rand -hex 32 > secrets/master.key
  echo "Creata secrets/master.key — FAI UN BACKUP SEPARATO: senza questa chiave le credenziali salvate non sono recuperabili."
fi

if [ ! -f secrets/tls.crt ] || [ ! -f secrets/tls.key ]; then
  openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 825 \
    -subj "/CN=GIGI OS ${IP}" \
    -addext "subjectAltName=IP:${IP},DNS:gigi-mini-pc.local,DNS:localhost" \
    -keyout secrets/tls.key -out secrets/tls.crt 2>/dev/null
  echo "Creato certificato TLS autofirmato per ${IP} (valido 825 giorni)."
fi

chown -R "$UIDGID" secrets data
chmod 400 secrets/master.key secrets/tls.key
chmod 444 secrets/tls.crt
echo "Impronta SHA-256 del certificato (confrontala con quella mostrata dal browser):"
openssl x509 -in secrets/tls.crt -noout -fingerprint -sha256
