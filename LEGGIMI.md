# GIGI OS

Control center self-hosted per **Gigi-Mini-Pc**: stato del server, container Docker, applicazioni e media in un'unica interfaccia web.

GIGI OS gira in un proprio stack Docker (`gigi-os`). Le altre applicazioni (Jellyfin, Apollo, qBittorrent, Armony, Navidrome, Home Assistant) **non dipendono** da GIGI OS e continuano a funzionare quando è fermo.

## Accesso

- Indirizzo: **https://192.168.222.200:8470**, raggiungibile solo dalla LAN 192.168.222.0/24 (regola UFW `GIGI OS LAN`).
- Il certificato è autofirmato e generato localmente. Al primo accesso il browser mostra un avviso. Confronta l'impronta SHA-256 con quella stampata da `scripts/init-secrets.sh` e accetta l'eccezione.
- **Primo avvio:** serve il codice di setup monouso, leggibile con
  ```
  docker logs gigi-api 2>&1 | grep "codice di setup"
  ```
  Con il codice si crea il primo amministratore (password di almeno 12 caratteri). Una volta usato, il codice viene eliminato.

## Funzionalità disponibili (V1)

| Sezione | Cosa fa | Note |
|---|---|---|
| Dashboard | CPU, RAM, disco, rete, temperatura, uptime, salute dei container, stato delle app, ultimi contenuti Jellyfin, download, eventi recenti | Widget trascinabili e ridimensionabili (pulsante «Personalizza»); il layout viene salvato per utente |
| Sistema | Storico di CPU, RAM e rete (ultima ora), utilizzo per core, temperature, dischi, interfacce; servizi systemd (stato, memoria, CPU, ultimo esito, **log dal journal**) ed errori di sistema | Sola lettura da cgroup, file delle unità e journal dell’host (D-021); avvio/riavvio non abilitati per scelta |
| Rete | **Schede rilevate** (Ethernet, Wi-Fi, bridge Docker, veth) con stato, velocità del link, driver, MAC, MTU, indirizzi IPv4/IPv6, traffico in tempo reale, errori; gateway, DNS reali, **IP pubblico** (con avviso facoltativo se cambia); **servizi in ascolto** con portata (locale / tutte le interfacce) e stato del firewall per porta; **firewall**: analisi dell’esposizione, porte Docker che scavalcano UFW, regole UFW (se è installata l’istantanea), **pacchetti bloccati** dal journal (sorgenti, porte, ultimi blocchi); **connessioni** TCP per host remoto; **test**: ping, tracepath, DNS a confronto (sistema, 1.1.1.1, 8.8.8.8, 9.9.9.9), porta TCP, HTTP/HTTPS con certificato, **test di velocità**; **dispositivi in LAN** (scansione, nomi, avviso facoltativo per i nuovi dispositivi) e **Wake-on-LAN** | Il viewer vede solo le schede. Tutto in sola lettura sull’host: **modificare IP e regole UFW non è disponibile** (servirebbe root, permesso non concesso, vedi D-026). Servizi esterni usati solo su richiesta o se attivi il monitoraggio: api.ipify.org/icanhazip.com (IP pubblico), speed.cloudflare.com (≈25 MB giù, 10 MB su). Test e scansioni in audit e con limiti di frequenza |
| Docker | Container (ricerca, filtri, ordinamento), dettaglio, healthcheck, mount, rete, variabili d'ambiente oscurate, log in diretta, immagini, volumi, reti; **eliminazione** di immagini, volumi, reti e container fermi (singola o in blocco) e **Spazio e pulizia** (immagini dangling/inutilizzate, volumi orfani, reti vuote, container fermi, cache di build) | Solo admin, conferma «ELIMINA» (cache di build: «SVUOTA»), esito per elemento, tutto in audit. Mai `force`: ciò che è in uso non si elimina. Le immagini costruite in locale (es. `armony-armony:prima-*`) sono segnalate e non preselezionate. Volumi e reti di `gigi-os` e i container `gigi-*` sono protetti |
| Stack | **Wizard** per nuovi stack compose: scegli la cartella dentro `/opt/stacks`, scrivi o carica `compose.yaml` e `.env`, verifica, avvia con l’output in diretta. Per gli stack creati da GIGI OS: modifica del compose, avvia/ferma/riavvia, aggiorna immagini, ripristino della versione precedente, down e rimozione (volumi solo su richiesta) | Solo admin. La verifica **blocca** nomi di stack o container già esistenti, porte occupate, mount dello stato di GIGI OS; **chiede conferma** (nome dello stack) per privileged, socket Docker, cartelle di sistema o di altri servizi, porte su tutte le interfacce (scavalcano UFW). Gli stack creati fuori da GIGI OS (jellyfin, armony, …) sono solo elencati. I valori del `.env` non vengono mai rimostrati |
| Media | Jellyfin (librerie, conteggi, scansioni, sessioni, ultimi aggiunti), Apollo (stato), qBittorrent (torrent, velocità, categorie) | Richiede le credenziali di Jellyfin e qBittorrent (vedi sotto) |
| File | File manager su `/srv/downloads` e `/srv/media`: navigazione, ricerca, anteprima (immagini, video, audio, testo), caricamento e scaricamento, nuova cartella, rinomina, sposta / copia / hardlink tra cartelle, permessi e proprietario, hardlink in libreria evidenziati | Solo admin, ogni modifica in audit. «Elimina» sposta nel **cestino** (ripristinabile); l’unica cancellazione definitiva è «Svuota cestino» con conferma «SVUOTA». Mai sovrascritture. Worker `gigi-files` senza rete |
| Download | Torrent di qBittorrent con filtri e selezione multipla: avvia/ferma, **seeding sì/no**, limiti di ratio e tempo per torrent, categoria, ricontrollo, eliminazione; **ricerca** con i plugin di qBittorrent; **aggiunta** da magnet o file `.torrent`; limiti globali di seeding; per ogni torrent lo stato in libreria | Solo admin per le azioni (in audit). L’aggiunta è confermata solo quando il torrent compare davvero in qBittorrent. Eliminazione a tre livelli: **ovunque** (torrent + download + copia in libreria + Jellyfin/Apollo, conferma «ELIMINA»), torrent e download, solo torrent. Al raggiungimento dei limiti il torrent viene fermato, mai rimosso |
| Media automation | Download completati → riconoscimento (nome, ffprobe, metadati TMDb tramite Jellyfin) → proposta con confidenza e motivazioni → import con **hardlink** → notifica e verifica in Jellyfin (e quindi Apollo) | Import automatico **spento** di default; sotto l’85% serve conferma; correzione manuale; duplicati e conflitti bloccati |
| Armony | Dispositivi e brano in riproduzione con comandi (play/pausa/avanti/indietro/volume), stato del server Armony, certificato del dominio, registro eventi, Navidrome, stack `armony` | Richiede la chiave API Armony (`arm_…`); comandi e registro solo per gli admin |
| Integrazioni | Aggiunta, verifica, modifica e rimozione dei connettori; credenziali cifrate | Jellyfin, qBittorrent, Navidrome, Home Assistant, Armony, Apollo, HTTP generico |
| Automazioni | Regole sugli eventi (Docker, sistema, integrazioni, media, download, backup) con livello minimo, filtro testo, antiripetizione e ore di silenzio; canali Home Assistant, ntfy, Telegram (con **rilevamento automatico del Chat ID**) e webhook con prova di invio; storico notifiche; registro eventi | 7 regole suggerite create **disattivate**. Segreti dei canali cifrati. Nuovi eventi: download completato, media da rivedere, servizio systemd in errore |
| Backup | Backup giornaliero (03:30, 14 copie) di database GIGI OS e motore media (`VACUUM INTO` + `integrity_check`), `.env`, `compose.yaml` e **configurazioni di qBittorrent e Jellyfin** (incluso `jellyfin.db` copiato a caldo); esecuzione manuale, download, eliminazione, guida al ripristino | La chiave master è esclusa salvo opzione esplicita. I backup sono in `/opt/gigi-os/backups` (stesso disco: scaricane copie altrove) |
| Sicurezza | Cambio password, sessioni attive, utenti e ruoli, audit log, modello di sicurezza | Ruoli: amministratore e sola lettura |

**Non disponibili per scelta:** avvio/riavvio dei servizi systemd (richiederebbe privilegi sull’host); azioni sugli stack non creati da GIGI OS. **Limite degli stack:** `build:` funziona solo con il builder classico e con il Dockerfile già nella cartella dello stack (niente `dockerfile_inline`). **Non ancora disponibile:** editor visuale delle automazioni.

**Notifiche attive:** canale Home Assistant `notify.persistent_notification` (campanella nel pannello di HA) con 8 regole. Per riceverle sul telefono: installa l’app Home Assistant, poi in Automazioni → Canali scegli `notify.mobile_app_…`, oppure aggiungi Telegram.

## Media automation: come funziona

1. Ogni 2 minuti `gigi-media` legge da qBittorrent i torrent **completi** (mai quelli in download, in verifica o con file mancanti) e registra i file video (esclusi sample e file sotto 50 MB).
2. Dopo 60 secondi di stabilità analizza il file: nome della release (fansub, scene, film, speciali/OVA, numerazione assoluta), ffprobe, ricerca nella libreria Jellyfin e nei provider di metadati **già configurati in Jellyfin** (TMDb/OMDb: nessuna chiave aggiuntiva).
3. Propone la destinazione nelle librerie esistenti, rispettando le convenzioni già in uso:

   | Tipo | Cartella | Nome file |
   |---|---|---|
   | Film | `/srv/media/Film/Titolo (Anno)/` | `Titolo (Anno).mkv` |
   | Serie | `/srv/media/SerieTV/Serie/Season NN/` | `Serie - SNNEMM.mkv` |
   | Anime film | `/srv/media/Anime/Film/Titolo (Anno)/` | `Titolo (Anno).mkv` |
   | Anime serie | `/srv/media/Anime/Serie/Serie/Season NN/` | `Serie - SNNEMM.mkv` (speciali in `Season 00`) |

   Se la serie esiste già in Jellyfin, usa **la sua cartella**. I sottotitoli esterni con lo stesso nome vengono collegati insieme al video.
4. **Confidenza** con motivazioni leggibili: dall’85% in su l’elemento è «Pronto», sotto va «Da rivedere». Numerazione assoluta, speciali, omonimi e categorie in conflitto abbassano il punteggio.
5. **Importazione**: un hardlink (nessuno spazio in più, nessuno spostamento: il torrent continua il seeding). Mai sovrascritture: se in destinazione c’è un file diverso l’elemento va in «Conflitto». Se lo stesso file è già in libreria con un altro nome (stesso inode) non viene creato un duplicato.
6. Dopo l’import, Jellyfin viene notificato con la stessa API usata da Sonarr/Radarr (`/Library/Media/Updated`). Poi GIGI OS controlla che il file compaia: «In libreria» significa visibile in Jellyfin e quindi in Apollo. Se dopo 5 controlli non compare, viene richiesta una scansione completa.

L’import automatico si attiva dalla pagina (casella «Import automatico ≥ 85%»). Ogni azione resta nello storico dell’elemento e nell’audit log.

## Collegare i servizi

Vai su **Integrazioni** e usa i pulsanti «Suggerite». Apollo, Armony e Navidrome (solo health) vengono creati in automatico al primo setup.

| Servizio | Credenziale | Dove ottenerla |
|---|---|---|
| Jellyfin | API key | Dashboard Jellyfin → Chiavi API → «+» (nome: GIGI OS) |
| qBittorrent | **API key** (consigliata, qBittorrent ≥ 5.2), in alternativa utente e password | Opzioni → Web UI → API key (inizia con `qbt_`) |
| Home Assistant | Long-lived access token | Profilo → Sicurezza → Token di accesso a lunga durata |
| Navidrome (facoltativo) | Utente Subsonic | Un utente Navidrome, meglio se non amministratore |
| Armony | Chiave API (`arm_…`) | In Armony: Profilo → Chiavi API. Una chiave «con comandi» abilita play/pausa/volume; una di sola lettura basta per stato e registro |

Le credenziali si inseriscono **solo dall'interfaccia**: vengono cifrate (AES-256-GCM) e non vengono mai rimandate al browser né scritte nei log.

## Gestione

Esegui tutti i comandi da `/opt/gigi-os`. Agiscono **solo** sullo stack GIGI OS.

```sh
docker compose ps                 # stato
docker compose logs -f api        # log dell'API
docker compose build && docker compose up -d   # aggiornare dopo modifiche al codice
docker compose stop               # fermare GIGI OS (gli altri servizi non ne risentono)
npm test                          # test unitari e di integrazione (serve Node 22 sull'host)
```

### Backup

Da salvare, **separatamente**:
- `secrets/master.key`: senza questa chiave le credenziali salvate non sono recuperabili.
- `data/gigi.sqlite`: utenti, integrazioni, layout, audit. Fai la copia a stack fermo, oppure con `sqlite3 data/gigi.sqlite ".backup copia.sqlite"`.

### Rollback

Lo stack è autonomo. Per rimuoverlo completamente:

```sh
docker compose down                                  # solo lo stack gigi-os
ufw delete allow from 192.168.222.0/24 to any port 8470 proto tcp
```

## Porte, variabili, permessi

- **Porta:** 8470/tcp sull'IP LAN, HTTPS. Nessuna altra porta: l'agent comunica solo tramite socket Unix.
- **Variabili:** vedi `.env.example`. Nel file `.env` non ci sono segreti.
- **Rete:** `gigi-api` monta in sola lettura `/run/systemd/resolve` (DNS reali dell’host) e contiene `ping` e `tracepath` (ICMP non privilegiato, nessuna capability). Le regole UFW si vedono solo se installi il timer di sola lettura: `sudo sh scripts/host/install-ufw-snapshot.sh` (rimozione con `--uninstall`); scrive `data/host/ufw-status.txt` ogni 5 minuti.
- **Stack del wizard:** in `/opt/stacks/<cartella>` (proprietario `gigi`): `compose.yaml`, `compose.yaml.prev` (versione precedente), `.env` (0600) e `.gigi-stack.json` (marcatore: solo le cartelle che lo contengono sono gestibili da GIGI OS). Per aggiungere altre radici: `GIGI_STACK_ROOTS` e un mount con lo **stesso percorso** nell’agent, cartella scrivibile dall’utente 1000.
- **Permessi:** `gigi-media` monta `/srv` in scrittura (unico modo per creare hardlink tra download e librerie), più `./data/media`. Il codice non elimina, non sposta e non sovrascrive mai file. Gira come utente 1000: le cartelle delle librerie devono essere scrivibili da quell’utente. `gigi-agent` monta `docker.sock` (accesso equivalente a root sull'host), `/opt/stacks` in scrittura e in sola lettura `/etc/os-release` e `/etc/hostname`; contiene il binario ufficiale `docker-compose` v5.6.0 (Apache-2.0). **Nota:** chi è admin di GIGI OS può avviare stack con privilegi arbitrari, quindi l’account admin equivale a root sull’host: usa una password robusta e non condividerlo. `gigi-api` monta `./data`, `./secrets` (in sola lettura) e il volume del socket. Entrambi girano come utente 1000, con filesystem in sola lettura, senza capability e con `no-new-privileges`.
- **Risorse:** circa 90 MB di RAM in totale a riposo (limiti: 384 MB agent, per lasciare spazio a `docker-compose` durante pull/avvio degli stack; 256 MB API; 256 MB media).

## Struttura

```text
apps/agent   processo privilegiato: metriche /proc e /sys, Docker Engine API (dockerode), log oscurati
apps/api     Fastify: auth, RBAC, CSRF, vault, connettori, audit, eventi, UI statica
apps/media   worker media: parser release, ffprobe, decisione, hardlink, verifica Jellyfin
apps/web     React + Vite + Tailwind: interfaccia
tests        test unitari e di integrazione (node --test)
scripts      init-secrets.sh (chiave master e certificato, idempotente)
```

Le scelte architetturali sono in `DECISIONS.md`; le regole di lavoro per gli agenti sono in `CLAUDE.md`.
