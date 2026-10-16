#!/bin/sh
# GIGI OS — installazione su un server Linux con Docker (D-034).
# Rileva IP, gruppi e fuso orario, scrive .env e compose.override.yaml (senza mai sovrascrivere quelli esistenti),
# crea chiave e certificato, propone la regola del firewall e avvia SOLO lo stack di GIGI OS.
# Uso: sudo ./install.sh [--ip 192.168.1.20] [--yes] [--build] [--firewall|--no-firewall] [--no-start] [--dry-run]
set -eu
cd "$(dirname "$0")"

DRY=0 YES=0 BUILD=0 START=1 FIREWALL=ask IP=""
usage() {
  cat <<'EOF'
Uso: sudo ./install.sh [opzioni]
  --ip IP          IP LAN su cui GIGI OS ascolta (predefinito: rilevato)
  --yes, -y        accetta i valori rilevati senza domande (il firewall resta invariato senza --firewall)
  --build          costruisce le immagini in locale invece di scaricarle
  --firewall       aggiunge la regola UFW per la rete locale senza chiedere
  --no-firewall    non tocca il firewall
  --no-start       prepara la configurazione ma non avvia lo stack
  --dry-run        mostra cosa farebbe, senza scrivere né avviare nulla
EOF
}
while [ $# -gt 0 ]; do
  case "$1" in
    --ip) IP="${2:-}"; shift ;;
    --yes|-y) YES=1 ;;
    --build) BUILD=1 ;;
    --firewall) FIREWALL=yes ;;
    --no-firewall) FIREWALL=no ;;
    --no-start) START=0 ;;
    --dry-run) DRY=1 ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'Opzione sconosciuta: %s\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

say() { printf '%s\n' "$*"; }
step() { printf '\n▸ %s\n' "$*"; }
info() { printf '  %s\n' "$*"; }
warn() { printf '  ⚠ %s\n' "$*" >&2; }
die() { printf '✖ %s\n' "$*" >&2; exit 1; }
run() { if [ "$DRY" = 1 ]; then info "[prova] $*"; else "$@"; fi; }
interactive() { [ "$YES" = 0 ] && [ -t 0 ]; }
ask() { # ask "domanda" "predefinito"
  if ! interactive; then printf '%s' "$2"; return; fi
  printf '  %s [%s]: ' "$1" "$2" >&2
  read -r a || a=""
  printf '%s' "${a:-$2}"
}
confirm() { # confirm "domanda" → 0 = sì (predefinito: no)
  interactive || return 1
  printf '  %s [s/N]: ' "$1" >&2
  read -r a || a=""
  case "$a" in s|S|si|sì|y|Y|yes) return 0 ;; *) return 1 ;; esac
}
is_ipv4() { printf '%s' "$1" | grep -Eq '^([0-9]{1,3}\.){3}[0-9]{1,3}$'; }

say "GIGI OS — installazione"
[ "$DRY" = 1 ] && say "(modalità prova: non viene scritto né avviato nulla)"

# ── 1. Prerequisiti ──
step "Prerequisiti"
[ "$(uname -s)" = Linux ] || die "Serve Linux"
[ "$DRY" = 1 ] || [ "$(id -u)" = 0 ] || die "Esegui con sudo: servono i permessi per i segreti, i gruppi e (se vuoi) il firewall"
command -v docker >/dev/null 2>&1 || die "Docker non trovato: installalo da https://docs.docker.com/engine/install/"
docker compose version >/dev/null 2>&1 || die "Serve Docker Compose v2 (docker compose)"
command -v openssl >/dev/null 2>&1 || die "Serve openssl per chiave e certificato"
info "Docker $(docker version --format '{{.Server.Version}}' 2>/dev/null || echo '?') · $(docker compose version --short 2>/dev/null) · $(uname -m)"

# ── 2. Rete ──
step "Rete"
if [ -z "$IP" ]; then
  IP="$(ip -4 route get 1.1.1.1 2>/dev/null | sed -n 's/.* src \([0-9.]*\).*/\1/p' | head -1)"
  [ -n "$IP" ] || IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
  IP="$(ask "IP LAN su cui GIGI OS ascolta" "${IP:-192.168.1.20}")"
fi
is_ipv4 "$IP" || die "IP non valido: $IP"
ip -4 addr 2>/dev/null | grep -q "inet $IP/" || warn "$IP non risulta su nessuna interfaccia di questo server"
SUBNET="$(ip -4 route 2>/dev/null | awk -v ip="$IP" '$0 ~ ("src " ip "( |$)") && /scope link/ {print $1; exit}')"
PORT="$(sed -n 's/^GIGI_PORT=//p' .env 2>/dev/null | tail -1)"
PORT="${PORT:-8470}"
info "IP $IP · rete locale ${SUBNET:-sconosciuta} · porta $PORT"

# ── 3. Gruppi e fuso orario ──
step "Permessi e fuso orario"
DOCKER_GID="$(getent group docker 2>/dev/null | cut -d: -f3)"
[ -n "$DOCKER_GID" ] || DOCKER_GID="$(stat -c %g /var/run/docker.sock 2>/dev/null || true)"
[ -n "$DOCKER_GID" ] || die "Impossibile ricavare il gruppo del socket Docker"
JOURNAL_GID="$(getent group systemd-journal 2>/dev/null | cut -d: -f3)"
if [ -z "$JOURNAL_GID" ]; then
  JOURNAL_GID="$DOCKER_GID"
  warn "Gruppo systemd-journal assente: log di sistema e servizi risulteranno «non disponibili»"
fi
TZV="$(timedatectl show -p Timezone --value 2>/dev/null || true)"
[ -n "$TZV" ] || TZV="$(cat /etc/timezone 2>/dev/null || true)"
[ -n "$TZV" ] || TZV="$(readlink /etc/localtime 2>/dev/null | sed 's|.*/zoneinfo/||')"
TZV="${TZV:-UTC}"
info "gruppo docker $DOCKER_GID · gruppo journal $JOURNAL_GID · fuso $TZV"

# ── 4. Cartelle ──
step "Cartelle"
MEDIA="$(sed -n 's/^GIGI_MEDIA_ROOT=//p' .env 2>/dev/null | tail -1)"
MEDIA="$(ask "Radice di download e media (stesso disco per gli hardlink)" "${MEDIA:-/srv}")"
[ -d "$MEDIA" ] || warn "$MEDIA non esiste: crealo prima dell'avvio (proprietario 1000:1000), altrimenti Docker lo crea vuoto come root"
for c in jellyfin qbittorrent; do
  if docker inspect "$c" >/dev/null 2>&1; then
    info "$c: $(docker inspect -f '{{range .Mounts}}{{if eq .Type "bind"}}{{.Source}}→{{.Destination}} {{end}}{{end}}' "$c")"
  fi
done
info "Le cartelle delle librerie Jellyfin si indicano in GIGI_MEDIA_LIBRARIES nel file .env (vedi i mount qui sopra)."

# ── 5. .env ──
step "File .env"
setkey() { # setkey FILE CHIAVE VALORE: imposta la chiave (solo per un .env nuovo)
  if grep -q "^$2=" "$1"; then sed -i "s|^$2=.*|$2=$3|" "$1"; else printf '%s=%s\n' "$2" "$3" >>"$1"; fi
}
# Repo GitHub da cui controllare le nuove versioni: quella da cui è stata clonata questa cartella
RELREPO="$(git -c safe.directory="$(pwd)" remote get-url origin 2>/dev/null | sed -n 's#^\(https://\|git@\|ssh://git@\)github\.com[:/]\([A-Za-z0-9_.-]*/[A-Za-z0-9_.-]*\)$#\2#p' | sed 's/\.git$//')"
VER="$(sed -n 's/^  "version": "\([^"]*\)".*/\1/p' package.json | head -1)"
[ -n "$RELREPO" ] || RELREPO="$(sed -n 's/^GIGI_RELEASE_REPO=//p' .env.example | head -1)"
LIBS="movies=$MEDIA/media/Movies,series=$MEDIA/media/TV,animeMovies=$MEDIA/media/Anime/Movies,animeSeries=$MEDIA/media/Anime/TV"
if [ -f .env ]; then
  info ".env esiste già: resta com'è; aggiungo solo le chiavi che mancano"
  missing=""
  for k in $(sed -n 's/^\([A-Z_][A-Z0-9_]*\)=.*/\1/p' .env.example); do grep -q "^$k=" .env || missing="$missing $k"; done
  if [ -n "$missing" ]; then
    info "mancano:$missing"
    if [ "$DRY" = 0 ]; then
      printf '\n# Aggiunte da install.sh il %s (valori di .env.example)\n' "$(date +%F)" >>.env
      for k in $missing; do
        case "$k" in
          GIGI_BIND) v="$IP" ;; DOCKER_GID) v="$DOCKER_GID" ;; JOURNAL_GID) v="$JOURNAL_GID" ;;
          GIGI_TZ) v="$TZV" ;; GIGI_MEDIA_ROOT) v="$MEDIA" ;; GIGI_RELEASE_REPO) v="$RELREPO" ;; GIGI_VERSION) v="${VER:-0.0.0}" ;;
          *) v="$(sed -n "s/^$k=//p" .env.example | head -1)" ;;
        esac
        printf '%s=%s\n' "$k" "$v" >>.env
      done
    fi
  fi
else
  if [ "$DRY" = 1 ]; then
    info "[prova] creerei .env da .env.example con GIGI_BIND=$IP DOCKER_GID=$DOCKER_GID JOURNAL_GID=$JOURNAL_GID GIGI_MEDIA_ROOT=$MEDIA GIGI_TZ=$TZV"
  else
    cp .env.example .env
    setkey .env GIGI_BIND "$IP"
    setkey .env DOCKER_GID "$DOCKER_GID"
    setkey .env JOURNAL_GID "$JOURNAL_GID"
    setkey .env GIGI_MEDIA_ROOT "$MEDIA"
    setkey .env GIGI_MEDIA_LIBRARIES "$LIBS"
    setkey .env GIGI_FILES_ROOTS "Media=$MEDIA"
    setkey .env GIGI_TZ "$TZV"
    setkey .env GIGI_RELEASE_REPO "$RELREPO"
    [ -z "$VER" ] || setkey .env GIGI_VERSION "$VER"
    chmod 644 .env  # nessun segreto (stanno in secrets/); gigi-api lo legge per includerlo nei backup
    info "creato .env (controlla GIGI_MEDIA_LIBRARIES)"
  fi
fi

# ── 6. compose.override.yaml: configurazioni di qBittorrent e Jellyfin nei backup ──
step "Backup di qBittorrent e Jellyfin"
config_of() { docker inspect -f '{{range .Mounts}}{{if eq .Destination "/config"}}{{.Source}}{{end}}{{end}}' "$1" 2>/dev/null || true; }
if [ -f compose.override.yaml ]; then
  info "compose.override.yaml esiste già: resta com'è"
else
  lines=""
  q="$(config_of qbittorrent)"
  if [ -n "$q" ] && [ -d "$q/qBittorrent" ]; then lines="$lines      - $q/qBittorrent:/backup-src/qbittorrent:ro\n"; fi
  j="$(config_of jellyfin)"
  if [ -n "$j" ]; then
    for sub in config root plugins/configurations data; do
      [ -d "$j/$sub" ] && lines="$lines      - $j/$sub:/backup-src/jellyfin/$sub:ro\n"
    done
  fi
  if [ -z "$lines" ]; then
    info "nessun container qbittorrent/jellyfin con /config: i backup includeranno solo GIGI OS"
  elif [ "$DRY" = 1 ]; then
    info "[prova] creerei compose.override.yaml con:"
    printf '%b' "$lines" | sed 's/^/  /'
  else
    { printf '# Generato da install.sh il %s: configurazioni da includere nei backup (sola lettura).\nservices:\n  api:\n    volumes:\n' "$(date +%F)"; printf '%b' "$lines"; } >compose.override.yaml
    info "creato compose.override.yaml"
  fi
fi

# ── 7. Segreti ──
step "Chiave master e certificato"
if [ "$DRY" = 1 ]; then
  [ -f secrets/master.key ] && info "secrets/ esiste già: resta com'è" || info "[prova] genererei chiave master e certificato per $IP"
else
  GIGI_BIND="$IP" sh scripts/init-secrets.sh
fi

# ── 8. Firewall ──
step "Firewall"
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
  if ufw status 2>/dev/null | grep -Eq "^$PORT(/tcp)? .*ALLOW"; then
    info "esiste già una regola per la porta $PORT"
  elif [ -z "$SUBNET" ]; then
    warn "rete locale non rilevata: aggiungi tu la regola, es. ufw allow from 192.168.1.0/24 to any port $PORT proto tcp"
  elif [ "$FIREWALL" = yes ] || { [ "$FIREWALL" = ask ] && confirm "Consentire la porta $PORT dalla rete $SUBNET in UFW?"; }; then
    run ufw allow from "$SUBNET" to any port "$PORT" proto tcp comment 'GIGI OS LAN'
  else
    info "firewall invariato. Per raggiungere GIGI OS: ufw allow from $SUBNET to any port $PORT proto tcp"
  fi
else
  info "UFW non attivo: verifica che la porta $PORT sia raggiungibile solo dalla rete locale"
fi

# ── 9. Immagini e avvio (solo lo stack gigi-os) ──
if [ "$START" = 0 ]; then
  say ""
  say "Configurazione pronta. Per avviare: docker compose up -d --build"
  exit 0
fi
step "Immagini"
PREFIX="$(sed -n 's/^GIGI_IMAGE_PREFIX=//p' .env 2>/dev/null | tail -1)"
if [ "$BUILD" = 1 ] || [ -z "$PREFIX" ]; then
  info "costruzione in locale (alcuni minuti)"
  run docker compose build
else
  info "download da ${PREFIX%/}"
  run docker compose pull
fi

step "Avvio"
run docker compose up -d
if [ "$DRY" = 0 ]; then
  i=0
  until [ "$(docker inspect -f '{{.State.Health.Status}}' gigi-api 2>/dev/null)" = healthy ] || [ $i -ge 60 ]; do sleep 2; i=$((i + 1)); done
  [ $i -lt 60 ] || warn "gigi-api non è ancora healthy: docker compose logs api"
fi

say ""
say "✔ GIGI OS: https://$IP:$PORT"
if [ "$DRY" = 0 ]; then
  say "  Impronta del certificato (confrontala con quella del browser):"
  openssl x509 -in secrets/tls.crt -noout -fingerprint -sha256 | sed 's/^/  /'
  code="$(docker logs gigi-api 2>&1 | sed -n 's/.*codice di setup monouso: \([A-Za-z0-9_-]*\).*/\1/p' | tail -1)"
  [ -n "$code" ] && say "  Codice per creare il primo amministratore: $code"
fi
say "  Fermare: docker compose stop · Aggiornare: sudo ./update.sh"
