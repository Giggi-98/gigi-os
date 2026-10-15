# Registro decisioni — GIGI OS

Voci append-only. Per ribaltare una decisione, aggiungerne una nuova che rimandi alla precedente.

---

## D-001 — Stack TypeScript end-to-end (2026-10-15)

**Contesto.** Il mini PC ha 4 core N95 e 7 GB di RAM, già condivisi con Jellyfin, Home Assistant e Armony. Serve un backend che parli con Docker, Jellyfin e qBittorrent, e un frontend ricco.
**Scelta.** Node.js 22 + TypeScript per agent e API (Fastify 5, dockerode), React 19 + Vite + Tailwind 4 per la UI.
**Alternative scartate.** FastAPI/Python: `guessit` (il miglior parser di nomi release) è in Python, ma due linguaggi raddoppiano toolchain e immagini già per la V1. Next.js: SSR inutile per una SPA in LAN.
**Conseguenze.** Un solo linguaggio e un'unica immagine Docker per entrambi i processi. Lo stack resta coerente con Apollo (React, Vite, TanStack).
**Da rivedere se** nella V3 i parser TypeScript (`@ctrl/video-filename-parser` e anitomy) risultano insufficienti per anime e fansub: in quel caso si aggiunge un worker Python isolato con `guessit` (LGPL, usato come libreria, compatibile).

## D-002 — Monolite modulare + agent privilegiato separato (2026-10-15)

**Contesto.** L'accesso a `docker.sock` equivale a root sull'host. Il precedente tentativo (`dashboard-gigi`) montava socket, `/` e `privileged` direttamente nel web server.
**Scelta.** Due processi dalla stessa immagine: `gigi-agent` (unico con il socket, nessuna porta di rete, operazioni nominate su un socket Unix) e `gigi-api` (web, auth, connettori, nessun accesso Docker diretto).
**Alternative scartate.** Un solo processo con il socket (superficie d'attacco uguale a quella della UI). docker-socket-proxy (filtra per endpoint ma non per container o per azione, e aggiunge un container). Microservizi (sproporzionati per un singolo host).
**Conseguenze.** Una vulnerabilità nell'API non dà accesso arbitrario a Docker, ma solo alle operazioni esposte dall'agent (lista, inspect, log, start/stop/restart). L'agent resta comunque equivalente a root: isolato, non innocuo.
**Da rivedere se** servono operazioni host (systemd, update): andranno nell'agent come operazioni in allowlist, mai come shell generica.

## D-003 — SQLite tramite `node:sqlite`, migrazioni SQL numerate (2026-10-15)

**Contesto.** Pochi utenti, pochi scritture, nessun accesso concorrente da più host.
**Scelta.** Il modulo integrato `node:sqlite` (Node ≥ 22.13), in modalità WAL. Migrazioni `NNN_nome.sql` applicate in transazione e registrate in `schema_migrations`.
**Alternative scartate.** better-sqlite3 (dipendenza nativa da compilare). Postgres/MariaDB (un servizio in più, più RAM). ORM/Drizzle (astrazione non necessaria per una decina di tabelle).
**Conseguenze.** Nessuna dipendenza nativa. Node emette un ExperimentalWarning, soppresso in produzione.
**Da rivedere se** `node:sqlite` cambia API in modo incompatibile, oppure se servono più worker in scrittura concorrente.

## D-004 — Password con scrypt, sessioni opache, CSRF per sessione (2026-10-15)

**Scelta.** scrypt nativo (N=2^15, r=8, p=1). Token di sessione casuale di 32 byte, nel DB solo lo SHA-256. Cookie HttpOnly + Secure + SameSite=Strict. Header `X-CSRF-Token` obbligatorio sulle mutazioni, più verifica dell'Origin. Blocco dei login persistente per IP e per utente.
**Alternative scartate.** Argon2id (richiede un modulo nativo; scrypt è accettato da OWASP). JWT (difficili da revocare, nessun vantaggio su un singolo server).
**Da rivedere se** serve accesso multi-istanza o SSO/OIDC.

## D-005 — Vault AES-256-GCM con chiave su file separato (2026-10-15)

**Scelta.** Segreti delle integrazioni cifrati con AES-256-GCM; AAD = id dell'integrazione. Chiave master di 32 byte in `secrets/master.key` (0400, montata in sola lettura), fuori dal database.
**Conseguenze.** Un dump del DB da solo non espone le credenziali. Se si perde la chiave, le credenziali vanno reinserite.
**Da rivedere se** si adotta un secret manager esterno o un TPM.

## D-006 — Rete host per api e agent, binding sul solo IP LAN (2026-10-15)

**Contesto.** Navidrome ascolta solo su 127.0.0.1:4533; Jellyfin e Home Assistant sono in rete host. Le porte pubblicate da Docker scavalcano UFW.
**Scelta.** `network_mode: host` per entrambi. L'API si lega a `192.168.222.200:8470` e l'accesso è governato da UFW (solo LAN). L'agent non apre porte.
**Alternative scartate.** Rete bridge con porta pubblicata (scavalca UFW e non raggiunge i servizi su 127.0.0.1 senza `host-gateway` e regole aggiuntive).
**Conseguenze.** La difesa SSRF (`GIGI_ALLOWED_TARGETS`) è necessaria, perché l'API vede anche i servizi locali.
**Da rivedere se** si espone GIGI OS tramite reverse proxy o VPN.

## D-007 — TLS con certificato autofirmato locale (2026-10-15)

**Scelta.** Certificato EC P-256 autofirmato (SAN: IP LAN, `gigi-mini-pc.local`), generato da `scripts/init-secrets.sh`, servito direttamente da Fastify.
**Alternative scartate.** HTTP in chiaro in LAN (cookie e credenziali intercettabili). Caddy/ACME (richiede un dominio pubblico o una CA interna; Caddy è già usato da Armony e non va toccato).
**Da rivedere se** viene introdotta una CA interna o un dominio con DNS challenge.

## D-008 — Grafici SVG propri invece di una libreria di charting (2026-10-15)

**Scelta.** Area e sparkline in SVG (circa 200 righe) con tooltip e token di tema.
**Alternative scartate.** ECharts (circa 1 MB) e Recharts (dipendenze d3) per 3 tipi di grafico.
**Da rivedere se** servono grafici complessi (heatmap, serie lunghe con zoom) nelle metriche storiche.

## D-009 — Visibilità dei dati sensibili per ruolo (2026-10-15)

**Scelta.** Il ruolo `viewer` vede stato, metriche e liste. Log dei container, variabili d'ambiente, comandi ed etichette sono riservati agli admin, anche se già oscurati dall'agent.
**Motivo.** L'oscuramento è euristico: i log possono contenere segreti in formati non previsti (caso reale: Jellyfin scrive «Logging out access token …», coperto dopo la verifica del 2026-10-15).
