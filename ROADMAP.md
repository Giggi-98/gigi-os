# Cose da fare

Elenco del lavoro rimasto, aggiornato al 16 ottobre 2026. Le scelte già fatte sono in `DECISIONS.md` (D-027 … D-039).

## 1. Traduzioni (fase C, in corso — D-035)

Fatto: sistema di traduzione, parti comuni (menu, intestazione, componenti, ricerca Ctrl+K, login, 2FA, dashboard e widget).

Per ogni pagina: `node scripts/dev/i18n-codemod.mjs apps/web/src/pages/<Pagina>.tsx`, conversione a mano delle frasi segnalate, aggiunta del file a `CONVERTED` in `tests/i18n.test.mjs`, traduzioni in `apps/web/src/i18n/en.json` (`node scripts/dev/i18n.mjs --missing`), screenshot nelle due lingue.

- [ ] Sistema, Aggiornamenti, Rete, Docker (con Stack e Pulizia)
- [ ] File, Media (con «Elimina dalla libreria»), Download, Media automation, Armony
- [ ] Automazioni (con Bot e digest), Integrazioni, Sicurezza, Backup, App
- [ ] Testi che citano Apollo come se ci fosse sempre (es. «Disponibile in Jellyfin/Apollo»): mostrarli solo se l’integrazione esiste
- [ ] API: messaggi d’errore nella lingua della richiesta (`Accept-Language`)
- [ ] Eventi salvati come chiave + variabili, non come testo italiano (oggi restano in italiano anche con l’interfaccia in inglese)
- [ ] Notifiche, bot Telegram e digest nella lingua scelta (impostazione della lingua del server)
- [ ] Nome del disco predefinito in `GIGI_DISKS` («Sistema (/)»)

## 2. Repo pubblica (fase D)

- [ ] Nuova repo con **storia pulita** (un primo commit, senza l’email aziendale degli autori di questa)
- [ ] Non pubblicare: `.env`, `secrets/`, `data/`, `backups/`, `compose.override.yaml` (specifico di questo server)
- [ ] `CLAUDE.md` contiene l’inventario di questo server: sostituirlo con una guida generica per chi contribuisce
- [ ] Ripulire `DECISIONS.md`, `LEGGIMI.md` e i test (`tests/*.test.mjs`) da IP, nomi dei container e percorsi di questo server
- [ ] `LICENSE` (AGPL-3.0), `NOTICE` (docker-compose Apache-2.0, qrcode MIT e le altre dipendenze), `SECURITY.md` (modello delle minacce, come segnalare vulnerabilità)
- [ ] `README.md` in inglese con screenshot e avvio rapido; `LEGGIMI.md` resta in italiano
- [ ] `CHANGELOG.md` (lo legge il workflow di release), `CONTRIBUTING.md`, modelli per issue e pull request
- [ ] Modalità demo con dati d’esempio dichiarati come tali (per screenshot e prove)
- [ ] Decidere il nome del progetto prima della prima release
- [ ] Primo giro reale dei workflow su GitHub (mai eseguiti): CI, Trivy, build arm64, release su GHCR

## 3. Installazione su altri server

- [ ] Ricavare le cartelle delle librerie da Jellyfin invece di chiederle (`GIGI_MEDIA_LIBRARIES`)
- [ ] `DOCKER_GID` e `JOURNAL_GID` senza valori predefiniti in `compose.yaml` (oggi li scrive l’installer)
- [ ] Prova su host diversi: Debian, Raspberry Pi OS (arm64), Proxmox, Unraid; host senza systemd o senza UFW
- [ ] Installer senza git (dall’archivio di una release)

## 4. Funzioni

- [ ] App Android (Capacitor, guscio che apre GIGI OS dalla LAN, certificato reso fidato) — blocco 5 della V6
- [ ] Launcher: riordino con trascinamento; link diretti ai titoli in Apollo (prima verificare il formato dei suoi link)
- [ ] Aggiornamento di GIGI OS con un clic dall’interfaccia (oggi `sudo ./update.sh`, D-037); tag firmati e verifica delle immagini
- [ ] Prima prova di `update.sh` su un server vero (provato solo in ambiente isolato con un `docker` finto)
- [ ] Cestino: svuotamento automatico dopo N giorni e spazio occupato in evidenza (D-038)
- [ ] Aggiornamenti: leggere `/run/reboot-required`; aggiornamento con un clic per gli stack autorizzati esplicitamente

## 5. Da guardare su questo server (Gigi-Mini-Pc)

- [ ] `apt update` non riesce dal 13 ottobre 2026: `sudo apt update` per vedere quale sorgente non risponde
- [ ] `apport.service` e `apport-autoreport.service` in errore (Sistema → Servizi; di solito innocui)
- [ ] `armony-https` usa Caddy 2.8.4, disponibile la 2.11.7 (stack di Armony: aggiornarlo dal suo compose)
