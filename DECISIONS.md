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

## D-010 — Parser delle release scritto in casa (2026-10-16)

**Contesto.** `@ctrl/video-filename-parser` (MIT, porting delle logiche di Sonarr/Radarr) restituisce titolo vuoto per `[EMBER] Ninja Kamui - 01`, S11E00 per `One Piece - 1100` e S20E24 per `Dune.Part.Two.2024`. `anitomyscript` non è più mantenuto dal 2022 e non funziona su Node 22.
**Scelta.** Parser dedicato in `apps/media/src/parse.ts`: scene SxxEyy/1x04, fansub ` - NN`/`vN`/batch, stagione nel titolo, speciali (OVA/ONA/SP) in stagione 0, numerazione assoluta marcata come tale, film con anno. Ogni deduzione è annotata e coperta da test su nomi reali.
**Supera** la parte di D-001 che prevedeva `@ctrl/video-filename-parser`/anitomy.
**Da rivedere se** compaiono molti nomi che il parser non interpreta: aggiungere casi ai test, oppure introdurre `guessit` in un worker Python isolato.

## D-011 — Worker media separato, hardlink-only, mai cancellazioni (2026-10-16)

**Scelta.** `gigi-media` è l’unico processo con `/srv` in scrittura (un solo mount, necessario perché gli hardlink tra mount diversi falliscono con EXDEV). Importa solo con `link()`, che è atomico e fallisce se la destinazione esiste. Nessuna operazione di unlink, rename o copia. Se sorgente e libreria sono su filesystem diversi, si ferma e lo segnala.
**Alternative scartate.** Spostamento (interrompe il seeding). Copia automatica (raddoppia lo spazio, la si fa solo su richiesta). Import nel processo API (darebbe scrittura su `/srv` al processo esposto in rete).
**Da rivedere se** le librerie vengono spostate su un altro disco: in quel caso serve una modalità copia esplicita, con conferma e stima dello spazio.

## D-012 — Metadati tramite i provider di Jellyfin (2026-10-16)

**Scelta.** Matching con `POST /Items/RemoteSearch/{Series|Movie}` di Jellyfin, che usa i provider già configurati (TMDb, OMDb), più la ricerca nella libreria locale. Nessuna chiave TMDb/AniList aggiuntiva e nessuna chiamata diretta a Internet dal worker.
**Conseguenze.** I nomi proposti coincidono con quelli che Jellyfin poi riconosce. Se Jellyfin è offline, gli elementi vanno in revisione.
**Da rivedere se** serve una mappatura migliore della numerazione assoluta degli anime (AniDB/AniList con una mappa episodio→stagione).

## D-013 — Credenziali al worker solo in memoria, per richiesta (2026-10-16)

**Scelta.** L’API decifra le credenziali di qBittorrent e Jellyfin e le passa a `gigi-media` nel corpo di ogni richiesta sul socket Unix. Il worker non vede il vault né la chiave master, e non salva segreti. Le mappature dei percorsi si ricavano dai mount reali dei container `qbittorrent` e `jellyfin` (tramite l’agent), non da configurazione manuale.
**Da rivedere se** il worker deve lavorare anche quando l’API è ferma.

## D-014 — Duplicati per inode su tutte le librerie (2026-10-16)

**Contesto.** Durante la prima analisi reale, «Chainsaw Man – The Movie Reze Arc» era già in libreria come file sciolto (hardlink fatto a mano). Il motore proponeva una seconda destinazione, cioè un duplicato in Jellyfin. L’import automatico era spento, quindi non è successo nulla.
**Scelta.** Prima di proporre e prima di importare, il worker indicizza `dev:inode` dei video presenti nelle quattro librerie. Se la sorgente è già presente, l’elemento risulta «già importato» con il percorso reale, senza nuovi collegamenti.

## D-015 — Integrazione Armony con chiave API (2026-10-16)

**Scelta.** Connettore Armony con chiave `arm_…` in Bearer: `/api/me`, `/api/live/stato`, `/api/stato`, `/api/log`. Comandi limitati a play/pause/toggle/next/prev/volume (niente transfer/handoff/enqueue). Registro e stato del server solo per gli admin; ogni comando va nell’audit.
**Da rivedere se** Armony espone nuove capability utili (download, notifiche) o se serve il canale `/api/live` in streaming al posto del polling ogni 5 s.

## D-016 — Controllo torrent tramite le API di qBittorrent (2026-10-16)

**Scelta.** Ricerca, aggiunta e gestione passano esclusivamente dalla WebUI API di qBittorrent (5.2, WebAPI 2.15). La ricerca usa il motore integrato con i plugin che l’utente ha già installato; GIGI OS non installa né gestisce plugin. I link aggiunti (magnet o http) li scarica qBittorrent, non GIGI OS.
**Salvaguardie.** Le operazioni sono in allowlist (start/stop/recheck/reannounce, categoria, limiti, aggiunta, eliminazione), solo per gli admin e sempre in audit (il contenuto dei file `.torrent` non viene salvato). L’azione globale al raggiungimento dei limiti viene forzata su «ferma». Eliminare *con i file* è rifiutato se il motore media ha elementi di quel torrent non ancora importati; si può forzare solo con una seconda conferma esplicita.
**Alternative scartate.** Prowlarr/Jackett come indicizzatori separati: sono servizi in più, e l’utente li ha rimossi.
**Da rivedere se** servono le notifiche di download completato in tempo reale (oggi c’è un polling ogni 3 s solo con la pagina aperta).

## D-017 — File manager in un worker separato, senza rete, con cestino (2026-10-16)

**Scelta.** `gigi-files` (`network_mode: none`, utente 1000, rootfs in sola lettura) espone le operazioni via socket Unix. Ogni percorso viene risolto con `realpath` dentro le radici consentite (`/srv/downloads`, `/srv/media`), quindi niente `..` e niente symlink verso l’esterno. «Elimina» è un `rename` in `<radice>/.gigi-trash/<lotto>` (istantaneo e ripristinabile); l’unica cancellazione definitiva è lo svuotamento del cestino, con conferma scritta. Upload su un file temporaneo con rinomina atomica; nessuna operazione sovrascrive. La copia è limitata a 4 GB: sullo stesso disco si usa l’hardlink.
**Perché separato da gigi-media.** Il motore media conserva la garanzia di non eliminare mai nulla (D-011). Un bug del file manager non può toccare la logica di import, e viceversa.
**Download dei file.** Il download e l’anteprima inline sono serviti con `Content-Security-Policy: sandbox` e `nosniff`; inline solo immagini, video, audio e PDF, tutto il resto come allegato.
**Da rivedere se** servono altre radici (es. `/home/gigi/armony/musica`): basta aggiungerle a `GIGI_FILES_ROOTS` e al mount.

## D-018 — Automazioni come regole su eventi, notifiche su canali esterni (2026-10-16)

**Scelta.** Ogni evento registrato (`events`) viene valutato dalle regole attive: sorgente, livello minimo, filtro testo, antiripetizione per titolo, ore di silenzio (gli errori passano comunque). Canali: servizio `notify.*` di Home Assistant (tramite l’integrazione già configurata), ntfy (pubblicazione JSON, UTF-8), Telegram e webhook. Le destinazioni pubbliche sono ammesse; quelle private solo se dentro le reti LAN autorizzate. I token sono cifrati nel vault (AAD `channel:<id>`) e non compaiono nei messaggi di errore. Le regole suggerite nascono disattivate.
**Alternative scartate.** Un editor a nodi stile Node-RED: per la V4 basta un modello evento→condizioni→notifica, e l’editor visuale resta una fase successiva. Un servizio esterno (Apprise, Gotify): sarebbe un container in più per quattro canali.
**Da rivedere se** servono azioni diverse dalla notifica (es. riavvio automatico di un container): richiedono conferme e limiti dedicati.

## D-019 — Backup interno di GIGI OS (2026-10-16)

**Scelta.** Snapshot dei database con `VACUUM INTO` (coerente durante l’esecuzione), `PRAGMA integrity_check` sulla copia, archivio `.tar.gz` scritto in casa (ustar minimale, nessuna dipendenza), retention configurabile, evento `backup` sia in caso di riuscita sia di errore. Nessun ripristino con un clic: la procedura è guidata e manuale.
**Esclusioni.** La chiave master è esclusa salvo opzione esplicita, perché un backup che la contiene equivale alle credenziali in chiaro. I dati degli altri servizi non sono inclusi: le loro configurazioni contengono segreti propri (es. `secrets.yaml` di Home Assistant) e richiederebbero mount aggiuntivi.
**Da rivedere se** si aggiunge un disco esterno o una destinazione remota (rsync/S3): il backup su un solo disco protegge da errori ed eventuali corruzioni, non da un guasto del disco.

## D-020 — systemd in sola lettura via D-Bus; bloccato da AppArmor (2026-10-16)

**Contesto.** Da utente non privilegiato, D-Bus consente di leggere unità e proprietà di systemd (verificato sull’host con l’utente 1000: 190 servizi letti, `RestartUnit` negato con `InteractiveAuthorizationRequired`). Dentro il container, però, il profilo AppArmor `docker-default` blocca anche la connessione al bus (`Hello`).
**Scelta attuale.** L’agent gestisce l’errore (prima mandava in crash il processo: corretto, dopo il fix 0 riavvii) e l’interfaccia mostra la causa. Nessuna modifica di sicurezza applicata senza consenso.
**Opzioni da autorizzare.** (a) `security_opt: apparmor=unconfined` solo per `gigi-agent`: l’agent ha già `docker.sock`, quindi è già equivalente a root, e l’aumento di privilegi è minimo. (b) Un profilo AppArmor dedicato che consenta solo D-Bus verso `org.freedesktop.systemd1`: richiede di caricare un profilo sull’host. Avvio/riavvio richiederebbero inoltre una regola polkit limitata a servizi in allowlist.

## D-021 — systemd e journal senza D-Bus, sola lettura (2026-10-16) — supera D-020

**Contesto.** Il permesso di disattivare AppArmor per `gigi-agent` è stato negato dalle protezioni dell’ambiente: rimane il profilo `docker-default`.
**Scelta.** Lo stato dei servizi si ricava da fonti in sola lettura dell’host: cgroup v2 (`/sys/fs/cgroup/system.slice`: in esecuzione, memoria, CPU, processi), file delle unità (descrizione, abilitazione) e journal persistente tramite `journalctl` (eventi del PID 1 per «in errore», log per servizio, errori di sistema delle ultime 24 h). L’agent ha un’immagine Debian trixie dedicata (journalctl 257, compatibile con il journal di systemd 259) e il gruppo `systemd-journal`. D-Bus è stato rimosso del tutto.
**Avvio/riavvio.** Non abilitati: servirebbe una regola polkit che darebbe gli stessi poteri anche all’utente `gigi` dell’host, con rischi reali (ssh, docker) a fronte di un beneficio limitato.

## D-022 — «Elimina ovunque» (2026-10-16) — eccezione esplicita a D-011

**Contesto.** L’utente vuole che eliminare un torrent possa rimuovere il contenuto ovunque: download, libreria, Jellyfin e Apollo.
**Scelta.** Opzione esplicita, preselezionata ma confermata scrivendo «ELIMINA». Ordine: (1) `gigi-files` elimina in modo definitivo i file di libreria registrati dal motore media, **solo se hanno lo stesso inode della sorgente** del torrent (un file diverso con lo stesso nome non viene toccato) e ripulisce le cartelle vuote fino alla libreria esclusa; (2) qBittorrent elimina il torrent con i file; (3) Jellyfin riceve `UpdateType: Deleted`; (4) gli elementi del motore media diventano «rimossi». Il motore media in sé continua a non eliminare mai nulla: l’eliminazione passa da `gigi-files`, orchestrata dall’API e registrata nell’audit.

## D-023 — Aggiunta torrent verificata (2026-10-16)

**Contesto.** `/torrents/add` risponde «Ok.» prima di scaricare il link. Un risultato di LimeTorrents puntava a una pagina HTML e l’aggiunta falliva in silenzio, mentre GIGI OS mostrava «Aggiunto».
**Scelta.** I risultati di ricerca vengono risolti con `search/downloadTorrent` del plugin, come fa l’interfaccia di qBittorrent. Ogni aggiunta è confermata solo quando compare un nuovo hash (attesa massima 20 s); se nel log di qBittorrent compare un errore di aggiunta, viene mostrato all’utente con una spiegazione.

## D-024 — Eliminazione di risorse Docker su richiesta (2026-10-16)

**Contesto.** L’utente vuole liberare spazio e fare ordine da GIGI OS: immagini e volumi inutilizzati, reti, container fermi. Sull’host ci sono 59 immagini/strati e 5 GB di cache di build; alcune immagini non usate sono versioni di rollback costruite in locale (`armony-armony:prima-*`).
**Scelta.** Operazioni nominate nell’agent, una risorsa per chiamata, **mai `force`**: un’immagine usata da un container (anche fermo), un volume montato o una rete con container collegati non si eliminano. Le immagini si eliminano solo per ID completo, con tutti i tag (un tag passato per errore cancellava anche gli altri tag della stessa immagine: verificato e corretto durante lo sviluppo). Container solo se fermi e non protetti. Volumi e reti `gigi-os_*` esclusi. Conferma «ELIMINA» con l’elenco esatto e selezionabile; esito per elemento e audit per elemento. Le immagini senza digest di registry sono segnalate come non riscaricabili e non preselezionate.
**Alternative scartate.** `docker system prune` / `image prune -a` (nessun controllo su cosa sparisce, includerebbe le versioni di rollback di Armony).
**Da rivedere se** serve una pulizia programmata: richiederebbe una regola esplicita (es. solo dangling) e una notifica.

## D-025 — Stack compose creati dal wizard (2026-10-16)

**Contesto.** L’utente vuole creare nuovi servizi da GIGI OS scegliendo dove salvarli e scrivendo o caricando il compose. Il Docker Engine API non gestisce i file compose.
**Scelta.** Binario ufficiale `docker-compose` (immagine `docker/compose-bin:v5.6.0`, Apache-2.0) nell’agent, invocato con argomenti fissi senza shell e con ambiente minimo (le variabili dell’agent non entrano nell’interpolazione). Gli stack vivono in `/opt/stacks` (radice scelta dall’utente), montata nell’agent con lo **stesso percorso** dell’host, così `./data` diventa un percorso host corretto. Percorsi validati senza `..` né symlink, al massimo 3 livelli. Uno stack è gestibile solo se la sua cartella contiene `.gigi-stack.json`: gli stack esistenti (jellyfin, apollo, qbittorrent, armony, homeassistant, gigi-os) sono elencati ma nessuna azione li può toccare. Prima di ogni avvio l’agent normalizza il compose con `docker-compose config` e applica controlli: **bloccanti** (nome di progetto o di container già usato, porta in ascolto sull’host, cartella esistente non vuota, mount di `/opt/gigi-os`) e **da confermare** col nome dello stack (privileged, socket Docker, cartelle di sistema o di altri servizi, capability, `pid: host`, porte su tutte le interfacce che scavalcano UFW). I controlli si ripetono lato agent al deploy. Operazioni lunghe come job con output in diretta; una sola operazione per stack alla volta. Il compose precedente resta in `compose.yaml.prev` per il ripristino. Il `.env` (0600) è write-only verso il browser.
**Conseguenze.** L’account admin di GIGI OS diventa di fatto equivalente a root sull’host (lo era già in parte tramite le operazioni Docker): i controlli riducono gli errori, non impediscono un uso volutamente privilegiato. `build:` funziona solo con il builder classico (buildx non incluso). L’agent passa a 384 MB di limite.
**Alternative scartate.** Implementare il compose sopra l’Engine API (reimplementazione fragile). Portainer (un altro container con il socket e la sua UI). Scrittura dei compose in `/opt/docker` (cartella root dei servizi esistenti: avrebbe richiesto di cambiarne i permessi). Shell generica nell’agent.
**Da rivedere se** servono build BuildKit (aggiungere buildx), più radici, o una seconda conferma (password) per i deploy con avvisi di rischio alto.

## D-026 — Rete e firewall in sola lettura; modifiche non abilitate (2026-10-16)

**Contesto.** L’utente vuole impostazioni delle schede di rete, firewall, test di rete, IP pubblico e servizi attivi, con modifiche protette (ripristino automatico e regole SSH/GIGI OS intoccabili). Leggere le regole UFW e cambiare IP o regole richiede root sull’host. L’unico modo senza toccare l’host era un helper privilegiato usa-e-getta avviato via `docker.sock` (`--privileged --pid host` + `nsenter`): il permesso di provarlo è stato **negato** dalle protezioni dell’ambiente, come per D-020.
**Scelta.** Tutto ciò che non richiede privilegi, in `gigi-api` (rete host, senza socket Docker: processo adatto a richieste verso l’esterno): schede da `/sys/class/net` e `os.networkInterfaces()`, rotte da `/proc/net/route`, porte e connessioni da `/proc/net/{tcp,udp}` con attribuzione certa ai container con porte pubblicate e «probabile» per le porte note, DNS da `/run/systemd/resolve` (ro), ping e tracepath non privilegiati (`ping_group_range` dell’host lo consente), test DNS/TCP/HTTP che restituiscono solo metadati (mai il corpo della risposta), test di velocità verso Cloudflare, scansione ARP con ping sweep limitato a reti /24 o più piccole, Wake-on-LAN. I pacchetti bloccati da UFW si leggono dal journal del kernel tramite l’agent (già autorizzato al journal, D-021). Le regole UFW si mostrano solo se l’utente installa un timer di root in sola lettura (`scripts/host/install-ufw-snapshot.sh`) che scrive `ufw status verbose` in `data/host/`: GIGI OS non ottiene privilegi.
**Monitoraggio.** IP pubblico e nuovi dispositivi sono controllati ogni 15 minuti solo se attivati (predefinito: spento); il controllo dei dispositivi legge passivamente la tabella ARP. Le novità diventano eventi della nuova sorgente `rete`, utilizzabile nelle automazioni.
**Alternative scartate.** Helper privilegiato (negato). Regola polkit o sudoers per l’utente 1000 (darebbe gli stessi poteri anche all’utente `gigi` dell’host, già scartato in D-021). Leggere `/var/log/ufw.log` (gruppo `adm`).
**Da rivedere se** l’utente autorizza esplicitamente un meccanismo privilegiato: le modifiche andrebbero allora in operazioni allowlist (nmcli/ufw) con ripristino automatico entro 90 s senza conferma e regole per SSH (22) e GIGI OS (8470) non eliminabili.


## D-027 — Storico delle metriche nel database dell’API (2026-10-16) — supera la parte di D-008 sui grafici solo a 1 ora

**Contesto.** Lo storico era in memoria nell’agent (720 campioni da 5 s = 1 ora) e si perdeva a ogni riavvio. L’utente vuole 30 giorni, i consumi per container e una previsione di riempimento dei dischi.
**Scelta.** `gigi-api` raccoglie ogni minuto dall’agent dati che già espone (`/v1/system/history`, `/v1/containers`, `/v1/system`) e li salva in `gigi.sqlite` (migrazione `003_metrics.sql`): host al minuto (media e picco della CPU, RAM, rete, load, temperatura), container in esecuzione a 5 minuti (somma e numero di campioni, quindi media corretta), dischi all’ora (ultimo valore). Retention `GIGI_METRICS_DAYS` (predefinito 30), pulizia ogni 6 ore. Le query raggruppano in circa 300 punti per grafico (24 h → 5 min, 7 g → 30 min, 30 g → 2 h); i punti senza dati restano `null` e il grafico mostra un buco, senza interpolare. Dopo un fermo dell’API fino a 1 ora i minuti mancanti si recuperano dallo storico in memoria dell’agent. 15 minuti e 1 ora restano dal vivo dall’agent.
**Previsione dei dischi.** Regressione lineare dello spazio usato sugli ultimi 14 giorni, solo con almeno 3 giorni e 48 punti; «stabile» sotto lo 0,5% del disco al mese. L’intervallo usa ±2 errori standard: i punti orari sono correlati, quindi è un ordine di grandezza e l’interfaccia la presenta come stima.
**Alternative scartate.** Storico nell’agent (gli servirebbe un mount scrivibile: è il processo con `docker.sock`). Prometheus + Grafana, VictoriaMetrics, InfluxDB (uno o più container e centinaia di MB di RAM per un singolo host). Downsampling a più livelli (non necessario sotto i ~15 MB stimati per 30 giorni). Una libreria di grafici: bastano i grafici SVG esistenti con un quinto colore (`--chart-5`, validato per daltonismo in entrambi i temi).
**Conseguenze.** Nessun nuovo mount, porta o permesso. Lo storico parte dal primo avvio con questa versione. Le metriche entrano nei backup insieme a `gigi.sqlite`.
**Da rivedere se** il database supera alcune decine di MB, se servono retention di mesi (aggregati giornalieri) o grafici con zoom (D-008).

## D-028 — Ruolo «operatore» (2026-10-16)

**Contesto.** L’utente vuole dare accesso ad amici tecnici. Finora c’erano solo admin (di fatto root sull’host, D-025) e sola lettura.
**Scelta.** Terzo ruolo `operator` in una gerarchia viewer < operator < admin, verificata nel backend su ogni route (`auth('operator')`). L’operatore può: avviare e riavviare i container consentiti da `GIGI_CONTROL_ALLOW` (non fermarli), leggere i log oscurati, gestire i torrent (avvia/ferma, categoria, limiti, ricontrollo, aggiunta, ricerca, rimozione **solo del torrent**, con `deleteFiles: false` esplicito), confermare, correggere, ignorare e rianalizzare gli elementi del motore media e lanciare una scansione, inviare i comandi di Armony. Restano solo admin: stack, file manager, utenti, integrazioni, canali e regole, backup, pulizia Docker, rete avanzata, audit, variabili d’ambiente, eliminazioni di file o libreria, preferenze globali di seeding, impostazioni del motore media. Le azioni dei connettori sono in allowlist per tipo (`OPERATOR_ACTIONS` in `routes.ts`): un’azione nuova è solo admin finché non viene aggiunta. Ogni rifiuto va nell’audit.
**Migrazione.** Il `CHECK` sui ruoli richiede di ricostruire `users` (004). `migrate()` esegue le migrazioni marcate `-- gigi:foreign-keys-off` con le chiavi esterne disattivate fuori dalla transazione e `foreign_key_check` prima del commit: senza, `DROP TABLE users` avrebbe cancellato a cascata sessioni e layout. Provata su una copia del database reale.
**Alternative scartate.** Permessi granulari per utente (una matrice da gestire per due o tre persone). Riuso di `viewer` con eccezioni (ambiguo e più fragile).
**Conseguenze.** Con il codice precedente un operatore verrebbe trattato come sola lettura: il rollback resta sicuro.
**Da rivedere se** servono permessi per singolo container o stack, o un operatore che possa anche fermare.

## D-029 — Verifica in due passaggi TOTP (2026-10-16)

**Scelta.** TOTP RFC 6238 (SHA-1, 6 cifre, 30 s, ±1 intervallo) scritto con `node:crypto` e verificato con i vettori ufficiali; segreto di 160 bit cifrato nel vault (AAD `mfa:<utente>`) nella tabella `user_mfa`; ogni intervallo vale una sola volta (`last_step`); 10 codici di recupero monouso salvati come SHA-256. Il login con 2FA rilascia un biglietto monouso in memoria (5 minuti, 5 tentativi) e crea la sessione solo dopo il codice, con lo stesso blocco persistente dei tentativi di login. **Obbligatoria per admin e operatori** (scelta dell’utente): finché non è configurata, il backend accetta solo le route di configurazione e il logout (`403 mfa_setup_required`), anche per le sessioni già aperte. Configurazione e disattivazione richiedono la password; l’attivazione chiude le altre sessioni. Un admin può azzerare la 2FA di un altro utente; dal server c’è `docker exec gigi-api node apps/api/dist/reset-mfa.js <utente>`. Eventi della nuova sorgente `sicurezza` per attivazioni, disattivazioni e azzeramenti. Il QR è generato nel browser con `qrcode` 1.5.4 (MIT).
**Alternative scartate.** `otplib`/`speakeasy` (dipendenza per 40 righe di codice standard). WebAuthn/passkey (più sicure, ma richiedono un’origine HTTPS fidata: il certificato è autofirmato, D-007). SMS/e-mail (servizi esterni).
**Limite noto.** Durante la configurazione obbligatoria, chi conosce la password di un admin che non ha ancora la 2FA può collegare il proprio telefono: il rischio esiste solo fino alla prima configurazione.
**Da rivedere se** si adotta un dominio con certificato valido (passkey), o se serve la conferma con codice per le azioni più rischiose (deploy di stack con avvisi).

## D-030 — Launcher delle app e Ctrl+K (2026-10-16)

**Contesto.** L’utente vuole un launcher stile Homarr con proposte automatiche e una ricerca globale. Quasi tutti i servizi sono in rete `host`, quindi Docker non dichiara le loro porte; Navidrome e il POT provider ascoltano solo su 127.0.0.1.
**Scelta: launcher.** Lista **condivisa e gestita dagli admin** (scelta dell’utente) nella tabella `launcher_apps` (migrazione 005). Le proposte si generano solo su richiesta e non vengono mai salvate da sole: integrazioni configurate (il loro `webUrl`; se punta a 127.0.0.1 l’app è segnalata come non apribile dal browser) e porte TCP in ascolto su indirizzi non locali, escluse quelle non web (SSH, DNS, Samba, BitTorrent…), quella di GIGI OS e quelle già coperte da un’integrazione verso un indirizzo di questo PC. Ogni porta è verificata con una sola GET che legge titolo e link dell’icona. La favicon si scarica dal server dell’app (solo destinazioni consentite da `GIGI_ALLOWED_TARGETS`, al massimo 256 KB, solo tipi immagine), si salva nel database e si serve da `/api/v1/launcher/:id/icon` con CSP `sandbox` e `nosniff`: la CSP della UI resta `img-src 'self'`. Per titolo e icona si segue al massimo un redirect e solo verso la stessa origine; `safeFetch` ora riporta la destinazione del redirect nell’errore, ma continua a non seguirlo. Stato di ogni app: dall’integrazione collegata (credenziali rifiutate = interfaccia comunque raggiungibile), poi dal container, poi da un controllo HTTP lato server ogni 2 minuti (timeout 3 s). Un indirizzo fuori dalle reti consentite (es. un sito esterno) risulta «non verificata», non «offline».
**Scelta: Ctrl+K.** Componente scritto in casa (combobox ARIA, ricerca per somiglianza): pagine, app, container, azioni rapide di avvio e riavvio (aprono la conferma esistente, non eseguono nulla), torrent, media da rivedere e titoli Jellyfin tramite la nuova risorsa di sola lettura `search` del connettore. I titoli si aprono in Jellyfin (`/web/#/details?id=…&serverId=…`, scelta dell’utente). La palette monta le sue query solo da aperta; la ricerca in Jellyfin parte da 2 caratteri con 250 ms di ritardo e la cache delle risorse ora ha un limite di 500 voci.
**Correzione collegata.** L’hook `onSend` sovrascriveva sempre `Content-Security-Policy` e `Cache-Control`: ora li imposta solo se la route non l’ha già fatto (le altre risposte API restano `no-store` con la CSP generale, verificato dai test).
**Alternative scartate.** `cmdk` (porta con sé Radix per una lista con tastiera). Icone da un catalogo esterno o da una CDN (CSP più larga e loghi di terzi da gestire). Proposte salvate automaticamente (il launcher si riempirebbe di porte senza interfaccia).
**Da rivedere se** servono launcher personali o preferiti per utente, il trascinamento per riordinare, o link diretti ai titoli in Apollo (prima va verificato il formato reale dei suoi link).

## D-031 — Bot Telegram interattivo e digest (2026-10-16)

**Contesto.** Il canale Telegram esistente sa solo inviare. L’utente vuole comandi dal telefono con azioni sicure e un riepilogo mattutino e settimanale.
**Scelta: ricezione.** Long polling di `getUpdates` da `gigi-api` (timeout 25 s, backoff fino a 5 minuti sugli errori): solo richieste in uscita, nessuna porta e nessun webhook. Il bot usa il token di un canale Telegram esistente ed è **spento finché un admin non lo attiva** (Automazioni → Bot e digest). L’offset si salva prima di gestire ogni aggiornamento, così nulla viene rielaborato dopo un errore o un riavvio. Telegram ammette un solo lettore di `getUpdates`: con il bot attivo, il rilevamento del Chat ID usa le chat già viste dal bot.
**Scelta: chi può usarlo.** Solo account Telegram **collegati a un utente GIGI OS** (scelta dell’utente) con `/collega CODICE`: codice monouso di 8 caratteri, valido 10 minuti, generato dalla sessione web (che ha già superato la 2FA); 5 tentativi errati ogni 15 minuti. Il bot applica a ogni messaggio il ruolo *attuale* dell’utente (D-028) e rifiuta chi è disabilitato o non ha la 2FA obbligatoria (D-029). Solo chat private; gli account non collegati ricevono al massimo una risposta ogni 10 minuti, i gruppi vengono ignorati. 20 messaggi al minuto per account. Se un servizio non risponde, il bot risponde con l’errore invece di tacere.
**Scelta: azioni.** Sola lettura: `/stato`, `/download`, `/media`, `/digest`. Operatori e admin: pausa e ripresa dei torrent, «Ignora» e «Importa» con **seconda conferma** che mostra destinazione e confidenza (anche per gli elementi sotto soglia, scelta dell’utente). I pulsanti contengono solo un token casuale di 128 bit, monouso, valido un’ora e legato all’account che ha ricevuto il messaggio; i permessi si ricontrollano al tocco. Le azioni passano dallo stesso codice dell’interfaccia (`MediaBridge.act`, `Integrations.action`) e finiscono nell’audit a nome dell’utente, con `via: telegram`. Testi in HTML di Telegram con escape di ogni dato.
**Scelta: digest.** Giornaliero alle 08:00 e settimanale il lunedì alle 08:00 (modificabili, **spenti finché non li attivi**), sui canali scelti, in testo semplice: storico delle risorse (D-027), dischi con previsione, backup, download completati, nuovi contenuti in libreria, coda di revisione, container, integrazioni da controllare, avvisi del periodo; il settimanale aggiunge i container più impegnativi e la crescita del disco. Se GIGI OS era spento, il digest parte entro 3 ore dall’orario previsto, mai due volte; se giornaliero e settimanale coincidono parte solo il settimanale.
**Correzione collegata: fuso orario.** `gigi-api` girava in UTC: il backup delle «03:30» partiva alle 05:30 italiane e le ore di silenzio erano spostate di 1–2 ore. Ora `TZ` (`GIGI_TZ`, predefinito `Europe/Rome`) è impostato in `compose.yaml`; Node usa i dati ICU integrati, senza pacchetti aggiuntivi.
**Per i test.** `GIGI_TELEGRAM_API` sostituisce l’indirizzo di Telegram con un server finto locale; in produzione non va impostata.
**Alternative scartate.** Webhook (porta pubblica e certificato valido). Bot aperto a una chat ID fissa (nessuna distinzione tra persone né ruoli). Librerie per bot come `grammy` o `telegraf` (quattro metodi dell’API non le giustificano).
**Da rivedere se** si vogliono notifiche push dall’app Android al posto di Telegram, comandi per altri servizi (Home Assistant, Armony), o una seconda conferma anche per pausa e ripresa.

## D-032 — Rilevamento degli aggiornamenti, senza aggiornare nulla (2026-10-16)

**Contesto.** Nessun meccanismo segnalava immagini nuove, versioni nuove dei tag fissati, pacchetti del sistema operativo o nuove release delle app. Sull’host, `apt update` non riesce dal 13 ottobre senza che nessuno se ne accorga.
**Scelta.** Solo rilevamento; gli aggiornamenti restano un’azione dell’utente (scelta dell’utente). Controllo ogni 12 ore (il primo 2 minuti dopo l’avvio) o su richiesta di un admin; risultato in `settings.updates.last`.
- **Immagini**: l’agent chiede al demone Docker il digest del tag sul registry (`/distribution/{ref}/json`, richieste HEAD che non consumano i limiti di Docker Hub, nessun download) e lo confronta con i `RepoDigests` dell’immagine in uso. Immagini senza digest = «costruite in locale», non confrontabili.
- **Versioni dei tag fissati**: l’API legge i tag da Docker Hub, GHCR (lscr.io compreso) e Quay, e propone il più recente della stessa forma (stesso prefisso, stesse parti numeriche, stesso suffisso, nessuna pre-release). Richieste solo verso un elenco fisso di host, anche dopo i redirect; tag in cache per 12 ore.
- **Sistema operativo** (sola lettura, nuovi mount nell’agent): riepilogo di update-notifier, timestamp di apt (`update-stamp` contro `update-success-stamp`: oltre 2 giorni di differenza = indici bloccati), unattended-upgrades, kernel installato in `/boot` più recente di quello in uso = riavvio necessario.
- **App**: Jellyfin (`HasUpdateAvailable`), entità `update.*` attive di Home Assistant (nuova risorsa di sola lettura), release di GIGI OS da `GIGI_RELEASE_REPO` (GitHub; vuoto finché la repo pubblica non esiste).
- **Azioni**: per gli stack creati da GIGI OS si rimanda a «Aggiorna immagini»; per gli altri si mostra il comando da eseguire nella loro cartella (scelta dell’utente), senza toccarli (CLAUDE.md §3).
- **Avvisi**: eventi della nuova sorgente `aggiornamenti`, uno per novità. La deduplicazione degli eventi dura 30 minuti, quindi le chiavi già segnalate sono salvate a parte (e restano anche se una sezione non risponde, per evitare doppioni dopo un errore). Riga nel digest; regola «Aggiornamenti disponibili» creata **spenta** una sola volta (`ensurePresets`: se l’utente la elimina non ricompare).
**Alternative scartate.** Watchtower o Diun (un altro container con il socket Docker, e Watchtower aggiorna da solo). Pull periodico delle immagini (scarica gigabyte per sapere se c’è una novità). `apt list --upgradable` nel container (servirebbe apt e un accesso più ampio all’host).
**Limiti noti.** Il conteggio dei pacchetti è quello di update-notifier: se apt non aggiorna gli indici è vecchio, e la pagina mostra la data. `/run/reboot-required` non è letto: il riavvio è segnalato solo per il kernel. Docker Hub restituisce i 100 tag aggiornati più di recente: per repository con moltissime varianti una versione potrebbe sfuggire.
**Da rivedere se** si vuole l’aggiornamento con un clic per stack autorizzati esplicitamente, o la lettura di `/run/reboot-required`.

## D-033 — Nessun valore di un singolo server nel codice (2026-10-16)

**Contesto.** Primo passo per la repo pubblica (fase A): IP `192.168.222.200`, rete `192.168.222.0/24`, nome dell’host, cartelle `/opt/docker/...`, `/home/gigi/armony`, `/srv` e librerie `Film/SerieTV/Anime` erano scritti in codice, `compose.yaml` e script.
**Scelta.**
- `GIGI_BIND` è obbligatoria in compose (errore esplicito se manca). Se `GIGI_ALLOWED_TARGETS` è vuota, l’API usa 127.0.0.1 più la rete dell’interfaccia che ha quell’IP (`lanOf`).
- Gli indirizzi web delle app non sono più fissi: i connettori dichiarano `webOnLan` e un URL di servizio `127.0.0.1` diventa lo stesso URL con l’IP di GIGI OS. Navidrome no: di norma ascolta solo in locale.
- Nessuna integrazione creata da sola al primo setup (prima Apollo, Armony e Navidrome). La voce Armony del menu compare solo se l’integrazione esiste.
- Le cartelle degli altri servizi che un nuovo stack non dovrebbe montare si ricavano dalle etichette `working_dir` dei container compose esistenti (più `GIGI_PROTECTED_PATHS`). La cartella di installazione di GIGI OS viene dall’etichetta del container `gigi-agent`.
- Cartelle configurabili con lo stesso percorso nei container (`GIGI_MEDIA_ROOT`, `GIGI_STACKS_ROOT`), più `GIGI_MEDIA_LIBRARIES` e `GIGI_FILES_ROOTS`. I mount dei backup di qBittorrent e Jellyfin passano in `compose.override.yaml`, specifico dell’host.
- Senza journal, systemd o apt le sezioni restituiscono «non disponibile» invece di un errore (provato con l’immagine dell’agent senza mount).
**Conseguenze per questo server.** Nessuna: i valori sono stati spostati in `.env` e `compose.override.yaml`. La configurazione risolta da `docker compose config` è identica a prima, salvo quattro variabili d’ambiente aggiunte.
**Da rivedere se** l’installer (fase B) genera `.env` e override da solo, o se le librerie si ricavano direttamente da Jellyfin.

## D-034 — Installer, immagini pubblicabili e automazioni GitHub (2026-10-16)

**Scelta: installer.** `install.sh` in POSIX sh (verificato con `sh` e `dash`), da eseguire con sudo dalla cartella della repo:
- rileva IP (rotta verso Internet), rete locale, GID di docker e systemd-journal, fuso orario e mount di Jellyfin e qBittorrent;
- scrive `.env` (permessi 644: nessun segreto, gigi-api lo legge per i backup) e genera `compose.override.yaml` dai mount `/config` dei container `qbittorrent` e `jellyfin`; su questo server il file generato è identico a quello scritto a mano;
- **non sovrascrive mai** `.env`, override e `secrets/`: di un `.env` esistente completa solo le chiavi mancanti, con i valori rilevati;
- il firewall cambia solo con conferma o `--firewall`; con `--yes` resta invariato;
- avvia solo lo stack `gigi-os`;
- `--dry-run` non scrive nulla (verificato sulla cartella reale confrontando i file); `--no-start` prepara la configurazione senza build né avvio.
**Scelta: immagini.** Il prefisso `GIGI_IMAGE_PREFIX` (vuoto = nomi locali di sempre) permette di usare `ghcr.io/<proprietario>/gigi-os{,-agent,-media}`. Il Dockerfile riceve `GIGI_VERSION` come argomento e dichiara licenza e versione nelle etichette OCI. Le immagini di base (node:22-alpine, node:22-trixie-slim, docker/compose-bin) esistono per amd64 e arm64 e non ci sono moduli nativi: la build arm64 si fa in CI con QEMU. In locale non è verificata, perché richiederebbe di installare binfmt/QEMU sull’host.
**Scelta: GitHub.**
- `ci.yml`: controllo dei tipi, test, `npm audit` delle dipendenze di produzione (soglia alta), build delle tre immagini e scansione Trivy (CRITICAL/HIGH con correzione disponibile).
- `release.yml`: a ogni tag `vX.Y.Z`, build multi-architettura, push su GHCR con `GITHUB_TOKEN` e release con le note dal CHANGELOG.
- Dependabot settimanale per npm, Docker e Actions.
**Correzione collegata.** Il primo `npm audit` ha trovato una vulnerabilità alta e tre moderate in `@fastify/static` 8 (aggiramento delle protezioni delle route con percorsi non canonici) e una moderata in `uuid` tramite `dockerode` 4. Aggiornati a `@fastify/static` 10.1.6 e `dockerode` 5.0.1: 0 vulnerabilità, test verdi, lettura di container, statistiche, log e digest provata sul Docker reale.
**Alternative scartate.** Installer `curl | sh` (si esegue codice non letto e senza la repo a portata di mano). Script in bash (meno portabile su Alpine e Debian minimale). Watchtower per gli aggiornamenti (vedi D-032).
**Da rivedere se** serve un installer senza git (archivio della release) o il rilevamento automatico delle librerie da Jellyfin.

## D-035 — Interfaccia in italiano e inglese (2026-10-16)

**Contesto.** Scelta dell’utente: inglese e italiano completo per la repo pubblica, inglese predefinito. Circa 1.500 testi nell’interfaccia e 250 messaggi dell’API, tutti scritti in italiano dentro il codice.
**Scelta.**
- Modulo `lib/i18n.ts` scritto in casa (nessuna dipendenza). Il **testo italiano è la chiave**: `t('Testo')`, con variabili `{nome}`, plurali `tn(n, 'singolare', 'plurale')` tramite `Intl.PluralRules`, frasi con elementi React `tr('… {cmd} …', { cmd: <code/> })`, chiavi con contesto `contesto::Testo` per le parole con più significati e `tk()` per le chiavi usate in modo dinamico. L’inglese sta in `apps/web/src/i18n/en.json`.
- Lingua: scelta salvata nel browser, altrimenti quella del browser (italiano se presente, inglese negli altri casi). Si cambia dall’intestazione, o dal menu sul telefono, e la pagina si ricarica. Date e numeri seguono la lingua (`Intl`, `locale`).
- Controllo: `scripts/dev/i18n.mjs` e `tests/i18n.test.mjs` falliscono se manca una traduzione, se le variabili non coincidono, se una chiave non è usata, o se in un file già convertito resta testo nel JSX. La conversione dei file si fa con `scripts/dev/i18n-codemod.mjs`, che lavora sull’albero sintattico TypeScript e non riformatta.
- Avanzamento: prima le parti comuni (menu, intestazione, componenti, ricerca, login, 2FA, dashboard e widget: 213 testi). Poi una pagina alla volta; infine i messaggi dell’API, gli eventi, il bot e il digest.
**Alternative scartate.** `react-i18next`/`i18next` (circa 40 kB e un contesto da propagare ovunque, anche alle etichette definite fuori dai componenti). Chiavi semantiche (`nav.dashboard`): andrebbero inventati e mantenuti 1.500 nomi, e un testo non ancora tradotto non sarebbe leggibile.
**Limite noto.** Eventi e messaggi delle integrazioni arrivano dal server già in italiano, e lo restano finché non si converte l’API: gli eventi andranno salvati come chiave più variabili, non come testo.
**Da rivedere se** si aggiungono altre lingue (servirà un dizionario anche per l’italiano e un fallback per lingua) o traduzioni dalla comunità (formato standard come JSON di i18next o PO).

## D-036 — Dispositivi fidati per la verifica in due passaggi (2026-10-16)

**Contesto.** Richiesta dell’utente: non chiedere il codice 2FA a ogni accesso dallo stesso browser, con un periodo scelto in giorni.
**Scelta.**
- Dopo il codice, al login compare «Ricorda questo dispositivo per N giorni» (non spuntato di default). Se spuntato, GIGI OS salva un cookie `gigi_trust` casuale (32 byte), `HttpOnly`, `SameSite=Strict`, `Secure` come quello di sessione, limitato a `/api/v1/auth` e con durata pari al periodo. Nel database (`trusted_devices`, migrazione 007) c’è solo l’hash SHA-256, con etichetta del browser, IP e scadenza. Massimo 20 dispositivi per utente: oltre, si toglie il più vecchio.
- Il cookie salta **solo** il codice: la password resta sempre obbligatoria e vale soltanto per l’utente che l’ha creato.
- Periodo unico per tutti, scelto dall’amministratore in Sicurezza → Il mio account: 0 (disattivati), 1, 7, 14, 30 (predefinito), 60 o 90 giorni. Accorciarlo accorcia anche i dispositivi già ricordati; 0 li elimina.
- I dispositivi si cancellano: uno o tutti dall’utente; tutti al cambio password, al reset della password o alla disattivazione dell’utente da parte di un admin, a disattivazione/ricollegamento della 2FA e con `reset-mfa.js`. Ogni azione finisce nell’audit log.
**Alternative scartate.** Prolungare la sessione (un furto del cookie di sessione darebbe accesso senza password). Periodo scelto dal singolo utente (un operatore potrebbe aggirare la politica dell’amministratore). Riconoscere il dispositivo da IP o user agent (facili da falsificare e instabili).
**Conseguenze.** Chi ottiene il cookie `gigi_trust` e la password entra senza codice fino alla scadenza: per questo il cookie non è leggibile da JavaScript e si può revocare.
**Da rivedere se** servono periodi diversi per ruolo, o WebAuthn/passkey (che renderebbe il dispositivo fidato superfluo).

## D-037 — Aggiornamento di GIGI OS con update.sh (2026-10-16)

**Contesto.** La repo è pubblica: gli altri server devono sapere quando esce una versione e poterla installare senza rischi. Fino a D-032 c’era solo il rilevamento, legato a una release GitHub che non era mai stata pubblicata.
**Scelta.**
- **Versione:** un tag `vX.Y.Z` uguale a `version` di `package.json` (il workflow di release lo verifica). `install.sh` scrive `GIGI_VERSION` dal `package.json`, `update.sh` lo aggiorna; la release GitHub e le immagini su GHCR sono un di più.
- **Rilevamento:** `releases/latest`; se la repo non ha release (404), il tag `vX.Y.Z` più alto. `GIGI_RELEASE_REPO` predefinita `Giggi-98/gigi-os`, ricavata da `install.sh` dal remote `origin` (così un fork controlla sé stesso).
- **Applicazione:** `sudo ./update.sh` sull’host, non un pulsante nell’interfaccia. Git gira come proprietario della cartella; si ferma con file del repository modificati o commit locali non contenuti nella versione; prima costruisce le immagini con lo stack in funzione, poi ferma API e worker media, copia `./data` e riavvia solo lo stack `gigi-os`. Se dopo due minuti `gigi-api` non è sano o un container non gira, rimette codice, `GIGI_VERSION` e dati di prima, e usa le immagini vecchie, che restano con il loro tag. Lo script si esegue da una copia temporanea, perché git lo sostituisce durante l’aggiornamento.
- Provato in un ambiente isolato con un `docker` finto: aggiornamento, già aggiornato, file modificati, build fallita, versione che non parte (ritorno automatico), ritorno a una versione precedente e di nuovo all’ultima.
**Alternative scartate.** Pulsante «Aggiorna» nell’interfaccia: `gigi-agent` dovrebbe scrivere nella cartella del codice e ricreare sé stesso (servirebbe un container di appoggio con il socket Docker, e un admin compromesso potrebbe far eseguire codice qualsiasi in modo ancora più diretto). Watchtower o simili (aggiornerebbero anche gli stack degli altri, vedi D-032). Solo immagini GHCR (oggi la maggior parte delle installazioni costruisce in locale).
**Conseguenze.** Il rilevamento interroga api.github.com senza token: 60 richieste all’ora per IP, abbondanti per un controllo ogni 12 ore. Tornando indietro con `--version` il database resta quello nuovo: le migrazioni sono solo in avanti, quindi va rimessa a mano la copia fatta prima.
**Da rivedere se** serve l’aggiornamento con un clic (container di appoggio dedicato, con conferma e 2FA), aggiornamenti automatici programmati, o firme delle release (tag firmati, verifica delle immagini con cosign).

## D-038 — Eliminare un titolo dalla libreria, anche da Jellyfin e Apollo (2026-10-16)

**Contesto.** L’utente ha eliminato «ovunque» un torrent di «Bastardi senza Gloria» e il film si avviava ancora. Verificato: quel torrent (una release DVD9) non era mai stato importato; il film in libreria veniva da un altro torrent, già rimosso, quindi «Elimina ovunque» non aveva niente di suo da togliere. Mancava un’eliminazione che parta dal titolo. In più il cestino del file manager falliva su `/srv/media` (cartella di root, `gigi-files` gira come 1000).
**Scelta.**
- **Elimina dalla libreria** (Media, solo admin): i file vengono da Jellyfin (`/Items` con `Path` e `MediaSources`, episodi compresi per serie e stagioni) e si traducono nei percorsi dell’host con i mount reali del container. `gigi-files` prepara l’anteprima (video, accessori con lo stesso nome, cartelle che restano vuote o con soli accessori, fino alla cartella della libreria esclusa) ed esegue: cestino della radice (predefinito, ripristinabile; cartella intera se si svuota) o eliminazione definitiva. Gli inode dell’anteprima vanno ripresentati alla conferma: se un file è cambiato, niente viene toccato. I torrent con gli stessi inode si possono rimuovere insieme (con i file scaricati).
- **Elimina ovunque**: le copie in libreria si cercano per inode nelle cartelle delle librerie di Jellyfin (non più solo tra gli elementi del motore media), e l’anteprima nel dialogo dice quali spariranno o che non ce ne sono.
- **Jellyfin**: dopo ogni eliminazione (anche cestino e ripristino dal file manager dentro una libreria) avviso `Library/Media/Updated` e scansione `Library/Refresh`, poi verifica che gli id spariscano (fino a 16 s, poi in background per 10 minuti, con evento). Provato su Jellyfin reale: con il solo avviso il titolo restava per oltre 10 s, con la scansione sparisce in circa 2 s.
- Cestino della radice Media: creato sull’host `/srv/media/.gigi-trash` (1000:1000, 700), su autorizzazione dell’utente.
**Alternative scartate.** `DELETE /Items/{id}` di Jellyfin: le librerie sono montate in sola lettura nel container di Jellyfin, e renderle scrivibili cambierebbe un servizio esistente. Scrivere nel database di Jellyfin: vietato. Eliminare anche le copie indipendenti (non hardlink) di un torrent in «Elimina ovunque»: non si può sapere con certezza che siano lo stesso contenuto.
**Conseguenze.** Ogni eliminazione avvia una scansione completa delle librerie di Jellyfin (secondi su questa libreria, di più su librerie molto grandi). Con il cestino lo spazio resta occupato finché non lo si svuota. Apollo non è verificato direttamente: mostra ciò che Jellyfin espone.
**Da rivedere se** le scansioni complete diventano pesanti (scansione della sola libreria interessata), o se si vuole lo svuotamento automatico del cestino dopo N giorni.

## D-039 — Controllo della libreria (2026-10-17)

**Contesto.** Dopo D-038 l’utente vedeva ancora in Jellyfin e Apollo film «cancellati». Verificato: il catalogo di Jellyfin corrispondeva al disco; erano stati eliminati i torrent (con i file scaricati), non le copie in libreria. Il sistema permetteva di farlo senza un avviso evidente, e non c’era modo di vedere cosa fosse rimasto.
**Scelta.** Scheda «Controllo libreria» in Media (solo admin, sola lettura): il catalogo di Jellyfin (film ed episodi con `Path`) tradotto sui percorsi dell’host e confrontato con il disco tramite `gigi-files`. Due elenchi: file con un solo collegamento (`nlink = 1`, cioè non condivisi con nessun download) e schede il cui file non esiste («Togli da Jellyfin» = avviso + scansione + verifica, D-038). L’eliminazione resta il dialogo di D-038, con anteprima e conferma. Nel dialogo dei torrent, l’anteprima delle copie in libreria vale anche per «Elimina torrent e file scaricati», con l’avviso che il titolo resta in Jellyfin e Apollo.
**Alternative scartate.** Eliminare in automatico le copie rimaste senza torrent (un file copiato a mano o importato da un altro disco ha anch’esso un solo collegamento). Togliere l’opzione «Elimina torrent e file scaricati» (serve per liberare i download tenendo il titolo).
**Conseguenze.** «Non collegato a un torrent» non vuol dire «da eliminare»: l’elenco va letto. Copie su un altro disco (niente hardlink possibili) risultano sempre non collegate.
**Da rivedere se** la libreria diventa molto grande (il controllo legge l’intero catalogo e fa un `lstat` per file) o se si vuole un controllo periodico con evento.
