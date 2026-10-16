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

