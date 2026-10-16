#!/bin/sh
# GIGI OS — aggiornamento all'ultima versione pubblicata (D-037).
# Scarica il codice dal repository git, ricostruisce (o scarica) le immagini, fa una copia di ./data,
# riavvia SOLO lo stack gigi-os e, se la nuova versione non parte, torna da solo alla precedente.
# Uso: sudo ./update.sh [--check] [--yes] [--main] [--version X.Y.Z] [--dry-run]
set -eu
# sh legge lo script man mano: git lo sostituisce durante l'aggiornamento, quindi si esegue una copia
if [ -z "${GIGI_UPDATE_SELF:-}" ]; then
  self="$(mktemp)"
  cp "$0" "$self"
  GIGI_UPDATE_SELF="$self" GIGI_UPDATE_DIR="$(cd "$(dirname "$0")" && pwd)" exec sh "$self" "$@"
fi
trap 'rm -f "$GIGI_UPDATE_SELF"' EXIT
cd "$GIGI_UPDATE_DIR"
DIR="$(pwd)"

CHECK=0 YES=0 MAIN=0 DRY=0 WANT=""
usage() {
  cat <<'EOF'
Uso: sudo ./update.sh [opzioni]
  --check          dice solo se c'è una versione nuova (esce con 10 se c'è)
  --yes, -y        non chiede conferma
  --main           segue il ramo main invece delle versioni pubblicate (per chi sviluppa)
  --version X.Y.Z  va a una versione precisa (anche precedente)
  --dry-run        mostra cosa farebbe, senza cambiare nulla
EOF
}
while [ $# -gt 0 ]; do
  case "$1" in
    --check) CHECK=1 ;;
    --yes|-y) YES=1 ;;
    --main) MAIN=1 ;;
    --version) WANT="${2:-}"; shift ;;
    --dry-run) DRY=1 ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'Opzione sconosciuta: %s\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

step() { printf '\n▸ %s\n' "$*"; }
info() { printf '  %s\n' "$*"; }
warn() { printf '  ⚠ %s\n' "$*" >&2; }
die() { printf '✖ %s\n' "$*" >&2; exit 1; }
semver() { printf '%s' "$1" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$'; }
# a > b tra versioni X.Y.Z
newer() { [ "$1" != "$2" ] && [ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | tail -1)" = "$1" ]; }
setkey() { if grep -q "^$1=" .env; then sed -i "s|^$1=.*|$1=$2|" .env; else printf '%s=%s\n' "$1" "$2" >>.env; fi; }

# ── Prerequisiti ──
[ -d .git ] || die "Questa cartella non è un repository git: aggiorna scaricando la nuova versione e rilanciando install.sh"
[ -f .env ] || die "Manca .env: GIGI OS non è ancora installato qui (sudo ./install.sh)"
command -v git >/dev/null 2>&1 || die "Serve git"
command -v docker >/dev/null 2>&1 || die "Serve Docker"
[ "$CHECK" = 1 ] || [ "$DRY" = 1 ] || [ "$(id -u)" = 0 ] || die "Esegui con sudo (install.sh e i file di ./data lo richiedono)"
[ -z "$WANT" ] || semver "$WANT" || die "Versione non valida: $WANT (serve X.Y.Z)"
[ -z "$WANT" ] || [ "$MAIN" = 0 ] || die "--version e --main non vanno insieme"

# git gira come proprietario della cartella: i file nuovi restano suoi e git non si lamenta della proprietà
OWNER="$(stat -c %U "$DIR")"
g() {
  if [ "$(id -u)" = 0 ] && [ "$OWNER" != root ] && command -v runuser >/dev/null 2>&1; then
    runuser -u "$OWNER" -- env HOME="$(getent passwd "$OWNER" | cut -d: -f6)" git -C "$DIR" "$@"
  else
    git -c safe.directory="$DIR" -C "$DIR" "$@"
  fi
}

if command -v flock >/dev/null 2>&1 && [ "$DRY" = 0 ] && [ "$CHECK" = 0 ]; then
  exec 9>"$DIR/.update.lock"
  flock -n 9 || die "Un altro aggiornamento è in corso"
fi

# Versione in uso: quella del container in esecuzione, altrimenti quella del .env
CUR="$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' gigi-api 2>/dev/null | sed -n 's/^GIGI_VERSION=//p' | head -1 || true)"
[ -n "$CUR" ] || CUR="$(sed -n 's/^GIGI_VERSION=//p' .env | tail -1)"
semver "${CUR:-x}" || CUR=0.0.0

step "Ricerca della nuova versione"
REMOTE="$(g remote get-url origin 2>/dev/null || true)"
[ -n "$REMOTE" ] || die "Il repository non ha un remote «origin»"
info "origine: $REMOTE"
g fetch --quiet --tags --force origin || die "Impossibile scaricare da origin (rete, o chiave SSH se la repo è privata)"

if [ "$MAIN" = 1 ]; then
  REF=origin/main
  NEW="$(g show origin/main:package.json | sed -n 's/^  "version": "\([^"]*\)".*/\1/p' | head -1)"
  semver "${NEW:-x}" || die "Versione non leggibile in package.json di origin/main"
else
  if [ -n "$WANT" ]; then
    TAG="v$WANT"
    g rev-parse -q --verify "refs/tags/$TAG" >/dev/null || die "La versione $WANT non esiste (git tag -l 'v*')"
  else
    TAG="$(g tag -l 'v*' | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | sort -V | tail -1 || true)"
    [ -n "$TAG" ] || { info "Nessuna versione pubblicata (tag vX.Y.Z) su origin: niente da fare"; exit 0; }
  fi
  REF="refs/tags/$TAG"
  NEW="${TAG#v}"
fi
TARGET="$(g rev-parse "$REF^{commit}")"
HEAD_SHA="$(g rev-parse HEAD)"

# Il codice cambia se HEAD non contiene già la versione; con --version si va esattamente lì (anche indietro)
CODE=1
if [ -n "$WANT" ]; then [ "$TARGET" != "$HEAD_SHA" ] || CODE=0
elif g merge-base --is-ancestor "$TARGET" HEAD; then CODE=0; fi
if [ "$CODE" = 0 ] && [ "$NEW" = "$CUR" ] && [ -z "$WANT" ]; then
  info "GIGI OS $CUR è già aggiornato"
  exit 0
fi
if [ -z "$WANT" ] && [ "$MAIN" = 0 ] && newer "$CUR" "$NEW"; then
  info "In uso $CUR, più recente dell'ultima pubblicata ($NEW): niente da fare"
  exit 0
fi
info "in uso: $CUR → nuova: $NEW"
if [ "$CODE" = 1 ]; then
  n="$(g rev-list --count "HEAD..$TARGET")"
  info "$n modifiche nel codice; le ultime:"
  g log --format='    %h %s' -n 10 "HEAD..$TARGET"
fi
if [ "$CHECK" = 1 ]; then exit 10; fi

# ── Controlli prima di cambiare qualcosa ──
[ -z "$(g status --porcelain --untracked-files=no)" ] || die "Ci sono file del repository modificati a mano (git status): salvali o annullali prima di aggiornare"
BRANCH="$(g symbolic-ref -q --short HEAD || true)"
if [ "$CODE" = 1 ] && ! g merge-base --is-ancestor HEAD "$TARGET"; then
  [ -n "$WANT" ] || die "Questo repository ha commit che la versione $NEW non contiene: aggiorna a mano (git log HEAD..$REF)"
fi
if [ "$YES" = 0 ] && [ "$DRY" = 0 ]; then
  [ -t 0 ] || die "Serve una conferma: rilancia con --yes"
  printf '  Aggiornare GIGI OS a %s? Il servizio resterà fermo un minuto circa. [s/N]: ' "$NEW"
  read -r a || a=""
  case "$a" in s|S|si|sì|y|Y|yes) ;; *) info "Annullato"; exit 0 ;; esac
fi
if [ "$DRY" = 1 ]; then
  info "[prova] porterei il codice a $REF, GIGI_VERSION=$NEW, costruirei le immagini, copierei ./data in backups/ e riavvierei lo stack gigi-os"
  exit 0
fi

# ── Codice ──
step "Codice"
move_to() { # move_to COMMIT: segue il ramo se si va avanti, altrimenti stacca la HEAD
  if [ -n "$BRANCH" ] && g merge-base --is-ancestor HEAD "$1"; then g merge --quiet --ff-only "$1"
  elif [ -z "$BRANCH" ] && g rev-parse -q --verify refs/heads/main >/dev/null && g merge-base --is-ancestor main "$1"; then
    # Dopo un ritorno a una versione precedente: si riprende il ramo main
    g checkout --quiet main && g merge --quiet --ff-only "$1"
  else g -c advice.detachedHead=false checkout --quiet --detach "$1"; fi
}
if [ "$CODE" = 1 ]; then move_to "$TARGET"; info "codice a $(g rev-parse --short HEAD)"; else info "il codice contiene già la versione $NEW"; fi
setkey GIGI_VERSION "$NEW"

back_code() {
  warn "ripristino del codice a $(printf %.7s "$HEAD_SHA") e di GIGI_VERSION=$CUR"
  if [ -n "$BRANCH" ]; then g checkout --quiet "$BRANCH" && g reset --quiet --keep "$HEAD_SHA"; else g checkout --quiet --detach "$HEAD_SHA"; fi
  setkey GIGI_VERSION "$CUR"
}

# Chiavi nuove del .env e file di configurazione (mai sovrascritti) con l'installer della nuova versione
step "Configurazione"
if ! sh ./install.sh --yes --no-firewall --no-start >/dev/null; then
  back_code
  die "install.sh della nuova versione non è riuscito: niente è stato riavviato"
fi
info "ok"

# ── Immagini (lo stack in esecuzione non viene toccato) ──
step "Immagini"
PREFIX="$(sed -n 's/^GIGI_IMAGE_PREFIX=//p' .env | tail -1)"
if [ -n "$PREFIX" ]; then OK=0; docker compose pull --quiet || OK=1; else info "costruzione in locale (alcuni minuti)"; OK=0; docker compose build --quiet || OK=1; fi
if [ "$OK" = 1 ]; then
  back_code
  die "immagini non pronte: GIGI OS $CUR continua a funzionare com'era"
fi

# ── Copia di ./data con i servizi che scrivono fermi ──
step "Copia dei dati"
STAMP="$(date +%Y%m%d-%H%M%S)"
SAVE="backups/update-$CUR-to-$NEW-$STAMP"
docker compose stop api media >/dev/null 2>&1 || true
mkdir -p backups
cp -a data "$SAVE"
info "$SAVE"

# ── Avvio e verifica ──
healthy() {
  i=0
  until [ "$(docker inspect -f '{{.State.Health.Status}}' gigi-api 2>/dev/null)" = healthy ]; do
    [ $i -lt 60 ] || return 1
    sleep 2; i=$((i + 1))
  done
  sleep 5
  # Nessun container dello stack fermo o in riavvio continuo
  ! docker compose ps -a --format '{{.Name}} {{.State}}' | grep -Ev ' running$' | grep -q .
}
step "Avvio di GIGI OS $NEW"
if docker compose up -d >/dev/null 2>&1 && healthy; then
  printf '\n✔ GIGI OS ora è alla versione %s\n' "$NEW"
  info "Copia dei dati di prima: $SAVE (si può cancellare dopo qualche giorno)"
  [ "$CUR" = "$NEW" ] || info "Le immagini $CUR restano per un eventuale ritorno: docker image ls '*gigi-os*'"
  exit 0
fi

warn "GIGI OS $NEW non è partito correttamente:"
docker compose ps -a --format '    {{.Name}} {{.State}} {{.Status}}' >&2 || true
docker compose logs --tail 20 api >&2 2>/dev/null || true
if [ "$CUR" = "$NEW" ] || [ "$CUR" = 0.0.0 ]; then
  die "stessa versione, nessun ritorno automatico. Dati di prima in $SAVE; codice di prima: git checkout $(printf %.7s "$HEAD_SHA")"
fi
step "Ritorno a $CUR"
docker compose stop >/dev/null 2>&1 || true
FAILED="backups/update-failed-$NEW-$STAMP"
mv data "$FAILED"
cp -a "$SAVE" data
back_code
if docker compose up -d >/dev/null 2>&1 && healthy; then
  warn "tornato a GIGI OS $CUR con i dati di prima dell'aggiornamento; i dati del tentativo sono in $FAILED"
  exit 1
fi
die "anche il ritorno a $CUR non parte: docker compose logs api. Dati di prima in $SAVE"
