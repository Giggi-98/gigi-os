# GIGI OS

Control center self-hosted per **Gigi-Mini-Pc**: stato del server, container Docker, applicazioni e media in un'unica interfaccia web.

GIGI OS gira in un proprio stack Docker (`gigi-os`). Le altre applicazioni (Jellyfin, Apollo, qBittorrent, Armony, Navidrome, Home Assistant) **non dipendono** da GIGI OS e continuano a funzionare quando è fermo.

## Installazione

Su un server Linux con Docker e Docker Compose v2:

```sh
git clone https://github.com/Giggi-98/gigi-os.git && cd gigi-os
sudo ./install.sh            # rileva IP, gruppi e fuso orario, poi chiede conferma
sudo ./install.sh --dry-run  # mostra cosa farebbe, senza scrivere né avviare nulla
```

L'installer:
- crea `.env` e `compose.override.yaml` e non li sovrascrive mai: se esistono, aggiunge solo le chiavi mancanti di `.env`;
- genera chiave master e certificato;
- trova le configurazioni di qBittorrent e Jellyfin da includere nei backup;
- con UFW attivo, **chiede** prima di aggiungere la regola per la rete locale (`--firewall` per farlo senza domande, `--no-firewall` per non toccarlo);
- avvia **solo** lo stack `gigi-os`.

Al termine controlla in `.env` le cartelle delle librerie (`GIGI_MEDIA_LIBRARIES`). Altre opzioni: `--ip`, `--yes`, `--build`, `--no-start`.

**Immagini già pronte:** con una release pubblicata, imposta nel `.env` `GIGI_IMAGE_PREFIX=ghcr.io/<proprietario>/` e `GIGI_VERSION=<versione>`. L'installer le scarica invece di costruirle (immagini per amd64 e arm64).

## Accesso

- Indirizzo: **https://<GIGI_BIND>:8470** (su questo server https://192.168.222.200:8470), raggiungibile solo dalla rete locale (regola UFW `GIGI OS LAN`).
- Il certificato è autofirmato e generato localmente. Al primo accesso il browser mostra un avviso. Confronta l'impronta SHA-256 con quella stampata da `scripts/init-secrets.sh` e accetta l'eccezione.
- **Primo avvio:** serve il codice di setup monouso, leggibile con
  ```
  docker logs gigi-api 2>&1 | grep "codice di setup"
  ```
  Con il codice si crea il primo amministratore (password di almeno 12 caratteri). Una volta usato, il codice viene eliminato.

**Lingua:** l’interfaccia è in inglese o in italiano, in base al browser. Si cambia con il pulsante EN/IT nell’intestazione (sul telefono in fondo al menu). La traduzione è in corso: alcune pagine e i messaggi che arrivano dal server sono ancora solo in italiano.

## Funzionalità disponibili (V1)

| Sezione | Cosa fa | Note |
|---|---|---|
| Dashboard | CPU, RAM, disco, rete, temperatura, uptime, salute dei container, stato delle app, ultimi contenuti Jellyfin, download, eventi recenti | Widget trascinabili e ridimensionabili (pulsante «Personalizza»); il layout viene salvato per utente |
| App | **Launcher** delle applicazioni raggruppate (Media, Casa…), con icona dell’app e stato live; «Cerca app» propone le app dalle integrazioni e dalle porte web in ascolto, poi scegli tu quali aggiungere; modifica, riordino, rimozione. Widget «App» per la dashboard | Lista unica per tutti, la gestiscono gli admin. Un’app raggiungibile solo da 127.0.0.1 viene segnalata come non apribile dal browser |
| Ricerca (Ctrl+K) | **Ctrl+K**, **Cmd+K** o **/** da qualsiasi pagina (sul telefono la lente in alto): pagine, app, container, torrent, media da rivedere, titoli di Jellyfin; azioni rapide «Riavvia …» per operatori e admin | Le azioni aprono la solita conferma, non eseguono nulla da sole. I titoli si aprono in Jellyfin |
| Sistema | Storico di CPU (media e picco), RAM, rete e temperatura: dal vivo per 15 minuti e 1 ora, **salvato per 24 ore, 7 e 30 giorni**; **consumi per container** (CPU e RAM, i 5 più pesanti più la tabella di tutti); **previsione di riempimento dei dischi**; utilizzo per core, temperature, dischi, interfacce; servizi systemd (stato, memoria, CPU, ultimo esito, **log dal journal**) ed errori di sistema | Sola lettura da cgroup, file delle unità e journal dell’host (D-021); avvio/riavvio non abilitati per scelta. Lo storico parte dal primo avvio della versione che lo include; i tratti vuoti sono periodi con GIGI OS fermo. La previsione dei dischi compare dopo 3 giorni di dati ed è una stima (D-027) |
| Aggiornamenti | Per ogni container: **nuova immagine** per lo stesso tag, **versione più recente** per i tag fissati (es. caddy 2.8.4 → 2.11.7), immagini costruite in locale; sistema operativo: pacchetti, indici di apt bloccati, aggiornamenti automatici, riavvio per nuovo kernel; Jellyfin, Home Assistant e GIGI OS. Controllo ogni 12 ore o con «Controlla ora» | Solo rilevamento: per gli stack non creati da GIGI OS mostra il comando da eseguire. Evento «aggiornamenti», riga nel digest, regola «Aggiornamenti disponibili» pronta ma spenta |
| Rete | **Schede rilevate** (Ethernet, Wi-Fi, bridge Docker, veth) con stato, velocità del link, driver, MAC, MTU, indirizzi IPv4/IPv6, traffico in tempo reale, errori; gateway, DNS reali, **IP pubblico** (con avviso facoltativo se cambia); **servizi in ascolto** con portata (locale / tutte le interfacce) e stato del firewall per porta; **firewall**: analisi dell’esposizione, porte Docker che scavalcano UFW, regole UFW (se è installata l’istantanea), **pacchetti bloccati** dal journal (sorgenti, porte, ultimi blocchi); **connessioni** TCP per host remoto; **test**: ping, tracepath, DNS a confronto (sistema, 1.1.1.1, 8.8.8.8, 9.9.9.9), porta TCP, HTTP/HTTPS con certificato, **test di velocità**; **dispositivi in LAN** (scansione, nomi, avviso facoltativo per i nuovi dispositivi) e **Wake-on-LAN** | Il viewer vede solo le schede. Tutto in sola lettura sull’host: **modificare IP e regole UFW non è disponibile** (servirebbe root, permesso non concesso, vedi D-026). Servizi esterni usati solo su richiesta o se attivi il monitoraggio: api.ipify.org/icanhazip.com (IP pubblico), speed.cloudflare.com (≈25 MB giù, 10 MB su). Test e scansioni in audit e con limiti di frequenza |
| Docker | Container (ricerca, filtri, ordinamento), dettaglio, healthcheck, mount, rete, variabili d'ambiente oscurate, log in diretta, immagini, volumi, reti; **eliminazione** di immagini, volumi, reti e container fermi (singola o in blocco) e **Spazio e pulizia** (immagini dangling/inutilizzate, volumi orfani, reti vuote, container fermi, cache di build) | Solo admin, conferma «ELIMINA» (cache di build: «SVUOTA»), esito per elemento, tutto in audit. Mai `force`: ciò che è in uso non si elimina. Le immagini costruite in locale (es. `armony-armony:prima-*`) sono segnalate e non preselezionate. Volumi e reti di `gigi-os` e i container `gigi-*` sono protetti |
| Stack | **Wizard** per nuovi stack compose: scegli la cartella dentro `/opt/stacks`, scrivi o carica `compose.yaml` e `.env`, verifica, avvia con l’output in diretta. Per gli stack creati da GIGI OS: modifica del compose, avvia/ferma/riavvia, aggiorna immagini, ripristino della versione precedente, down e rimozione (volumi solo su richiesta) | Solo admin. La verifica **blocca** nomi di stack o container già esistenti, porte occupate, mount dello stato di GIGI OS; **chiede conferma** (nome dello stack) per privileged, socket Docker, cartelle di sistema o di altri servizi, porte su tutte le interfacce (scavalcano UFW). Gli stack creati fuori da GIGI OS (jellyfin, armony, …) sono solo elencati. I valori del `.env` non vengono mai rimostrati |
| Media | Jellyfin (librerie, conteggi, scansioni, sessioni, ultimi aggiunti), Apollo (stato), qBittorrent (torrent, velocità, categorie); **Elimina dalla libreria**: cerca un film, una serie, una stagione o un episodio (o usa il cestino sugli ultimi aggiunti) e toglilo da Jellyfin e Apollo | Richiede le credenziali di Jellyfin e qBittorrent (vedi sotto). Eliminazione solo admin, in audit, con anteprima dei file e conferma «ELIMINA» (vedi «Eliminare un titolo») |
| File | File manager su `/srv/downloads` e `/srv/media`: navigazione, ricerca, anteprima (immagini, video, audio, testo), caricamento e scaricamento, nuova cartella, rinomina, sposta / copia / hardlink tra cartelle, permessi e proprietario, hardlink in libreria evidenziati | Solo admin, ogni modifica in audit. «Elimina» sposta nel **cestino** (ripristinabile); qui l’unica cancellazione definitiva è «Svuota cestino» con conferma «SVUOTA». Cestinare o ripristinare qualcosa in una libreria aggiorna anche Jellyfin. Mai sovrascritture. Worker `gigi-files` senza rete |
| Download | Torrent di qBittorrent con filtri e selezione multipla: avvia/ferma, **seeding sì/no**, limiti di ratio e tempo per torrent, categoria, ricontrollo, eliminazione; **ricerca** con i plugin di qBittorrent; **aggiunta** da magnet o file `.torrent`; limiti globali di seeding; per ogni torrent lo stato in libreria | Solo admin per le azioni (in audit). L’aggiunta è confermata solo quando il torrent compare davvero in qBittorrent. Eliminazione a tre livelli: **ovunque** (torrent + download + copie in libreria + Jellyfin/Apollo, conferma «ELIMINA»; prima mostra quali copie in libreria spariranno, oppure che non ce ne sono), torrent e download, solo torrent. Al raggiungimento dei limiti il torrent viene fermato, mai rimosso |
| Media automation | Download completati → riconoscimento (nome, ffprobe, metadati TMDb tramite Jellyfin) → proposta con confidenza e motivazioni → import con **hardlink** → notifica e verifica in Jellyfin (e quindi Apollo) | Import automatico **spento** di default; sotto l’85% serve conferma; correzione manuale; duplicati e conflitti bloccati |
| Armony | Dispositivi e brano in riproduzione con comandi (play/pausa/avanti/indietro/volume), stato del server Armony, certificato del dominio, registro eventi, Navidrome, stack `armony` | Richiede la chiave API Armony (`arm_…`); comandi e registro solo per gli admin |
| Integrazioni | Aggiunta, verifica, modifica e rimozione dei connettori; credenziali cifrate | Jellyfin, qBittorrent, Navidrome, Home Assistant, Armony, Apollo, HTTP generico |
| Automazioni | **Flussi** in un editor grafico (stile n8n): blocchi di ricezione, logica e azioni collegati tra loro, con storico di ogni esecuzione (vedi «Flussi»). Regole sugli eventi (Docker, sistema, integrazioni, media, download, backup) con livello minimo, filtro testo, antiripetizione e ore di silenzio; canali Home Assistant, ntfy, Telegram (con **rilevamento automatico del Chat ID**) e webhook con prova di invio; storico notifiche; registro eventi | 7 regole suggerite create **disattivate**. Segreti dei canali cifrati. Nuovi eventi: download completato, media da rivedere, servizio systemd in errore |
| Bot e digest | **Bot Telegram** per gli account collegati (`/collega` da Sicurezza → Il mio account → Telegram): `/stato`, `/download`, `/media`, `/digest`; operatori e admin mettono in pausa o riprendono i torrent e importano o ignorano i media (import con doppia conferma). **Digest** giornaliero e settimanale su Telegram, ntfy o Home Assistant, con anteprima e invio manuale | Bot e digest sono spenti finché un admin non li attiva (Automazioni → Bot e digest). Ogni azione dal telefono va nell’audit a nome dell’utente |
| Backup | Backup giornaliero (03:30, 14 copie) di database GIGI OS e motore media (`VACUUM INTO` + `integrity_check`), `.env`, `compose.yaml` e **configurazioni di qBittorrent e Jellyfin** (incluso `jellyfin.db` copiato a caldo); esecuzione manuale, download, eliminazione, guida al ripristino | La chiave master è esclusa salvo opzione esplicita. I backup sono in `/opt/gigi-os/backups` (stesso disco: scaricane copie altrove) |
| Sicurezza | Cambio password, **verifica in due passaggi** (app di autenticazione, codici di recupero, cambio telefono), sessioni attive, **dispositivi fidati** (codice non richiesto per un periodo scelto dall’admin), utenti e ruoli con stato della 2FA e azzeramento, audit log, modello di sicurezza | Ruoli: amministratore, **operatore**, sola lettura (vedi sotto). 2FA obbligatoria per amministratori e operatori |

**Non disponibili per scelta:** avvio/riavvio dei servizi systemd (richiederebbe privilegi sull’host); azioni sugli stack non creati da GIGI OS. **Limite degli stack:** `build:` funziona solo con il builder classico e con il Dockerfile già nella cartella dello stack (niente `dockerfile_inline`). **Non ancora disponibile:** editor visuale delle automazioni.

**Orari:** backup, ore di silenzio e digest seguono il fuso `GIGI_TZ` (predefinito `Europe/Rome`). Fino al 16 ottobre 2026 `gigi-api` usava UTC e il backup delle 03:30 partiva alle 05:30 italiane.

**Notifiche attive:** canale Home Assistant `notify.persistent_notification` (campanella nel pannello di HA) con 8 regole. Per riceverle sul telefono: installa l’app Home Assistant, poi in Automazioni → Canali scegli `notify.mobile_app_…`, oppure aggiungi Telegram.

## Ruoli e verifica in due passaggi

| Ruolo | Può | Non può |
|---|---|---|
| Amministratore | Tutto | — |
| Operatore | Avviare e riavviare container, leggerne i log; gestire i torrent (avvia/ferma, categoria, limiti, aggiunta, ricerca, rimozione del solo torrent); confermare e correggere i media da rivedere, lanciare una scansione; comandi di Armony | Fermare container, stack, file, utenti, integrazioni, automazioni, backup, pulizia Docker, eliminazioni di file o dalla libreria |
| Sola lettura | Vedere stato, metriche e liste | Log, variabili d’ambiente, qualsiasi azione |

**Verifica in due passaggi (2FA).** Per amministratori e operatori è obbligatoria: al primo accesso GIGI OS mostra solo la schermata di configurazione. Serve un’app di autenticazione (Aegis, 2FAS, Google o Microsoft Authenticator): conferma la password, inquadra il QR, inserisci il codice e **salva i 10 codici di recupero** fuori dal PC (ognuno vale una volta). Per la sola lettura è facoltativa (Sicurezza → Il mio account).

**Dispositivi fidati.** Dopo il codice puoi spuntare «Ricorda questo dispositivo per N giorni»: su quel browser, per quel periodo, basta la password. Il periodo lo sceglie l’amministratore in Sicurezza → Il mio account → Dispositivi fidati (ogni accesso, 1, 7, 14, 30 — predefinito —, 60 o 90 giorni). Nella stessa scheda ogni utente vede i propri dispositivi e può rimuoverli; vengono rimossi tutti anche cambiando password o ricollegando la 2FA. Non usarlo su computer condivisi.

- **Telefono nuovo:** Sicurezza → Il mio account → «Cambia telefono» (password + codice o codice di recupero), poi si configura il nuovo.
- **Telefono perso con codici di recupero:** al login scegli «Usa un codice di recupero».
- **Un altro utente ha perso tutto:** un amministratore usa «Azzera» nella tabella Utenti.
- **L’unico amministratore ha perso telefono e codici:** dal server
  ```
  docker exec gigi-api node apps/api/dist/reset-mfa.js <utente>
  ```
  L’operazione chiude le sessioni dell’utente e finisce nell’audit; al login successivo si configura di nuovo.

## Eliminare un titolo

Un film o un episodio in libreria è un file diverso dal torrent: spesso è un **hardlink** (stesso file sul disco, due nomi), a volte una copia indipendente. Per questo ci sono due strade:

- **Media → Elimina dalla libreria** (parti dal titolo). GIGI OS chiede a Jellyfin quali file compongono il titolo (per una serie o una stagione, tutti gli episodi), li traduce nei percorsi del server e mostra un’anteprima: video, accessori con lo stesso nome (sottotitoli, `.nfo`, immagini), cartelle che resterebbero vuote, spazio liberato e torrent di qBittorrent che condividono gli stessi file (spuntati, si possono escludere). Poi:
  - **Sposta nel cestino** (predefinito): sparisce subito da Jellyfin e Apollo, si ripristina dal file manager (cestino della radice `Media`); lo spazio si libera svuotando il cestino.
  - **Elimina definitivamente**: non si può annullare.
- **Download → Elimina ovunque** (parti dal torrent): elimina il torrent con i suoi file e le sue copie in libreria riconosciute dall’inode, anche quelle importate prima di GIGI OS. Se il torrent non ha copie in libreria, lo dice prima della conferma: in quel caso Jellyfin non cambia, e per togliere il titolo si usa «Elimina dalla libreria».

**Controllo libreria** (Media, in alto): confronta il catalogo di Jellyfin con i file sul disco e con i torrent. Elenca i titoli **non collegati a nessun torrent** (di solito il torrent è stato eliminato con «Elimina torrent e file scaricati», che lascia la copia in libreria) con il pulsante «Elimina», e le schede di Jellyfin **senza più il file** con «Togli da Jellyfin». Non elimina niente da solo. Nel dialogo di eliminazione dei torrent, scegliendo «Elimina torrent e file scaricati» compare l’avviso se il titolo resterà in Jellyfin e Apollo.

Dopo l’eliminazione GIGI OS avvisa Jellyfin, avvia la scansione delle librerie e controlla che il titolo sia sparito (di solito in pochi secondi). Se il titolo è ancora lì e GIGI OS verifica che **tutti** i suoi file mancano dal disco, chiede a Jellyfin di toglierlo dal catalogo: serve soprattutto quando si elimina l’ultimo titolo di una libreria, perché Jellyfin salta le cartelle vuote durante la scansione (per non svuotare il catalogo se un disco non è montato). Se serve ancora tempo, continua in background e lo segnala con un evento. «Aggiunti di recente» e le ricerche si aggiornano da soli. Apollo mostra ciò che ha Jellyfin, quindi il titolo sparisce anche lì. Jellyfin vede le librerie in sola lettura: i file li toglie `gigi-files`, solo dentro `GIGI_FILES_ROOTS` e dentro le cartelle delle librerie di Jellyfin, mai la cartella della libreria stessa. Se un file cambia tra l’anteprima e la conferma (inode diverso), non viene toccato niente.

Il cestino della radice `Media` è `/srv/media/.gigi-trash`: se `/srv/media` appartiene a root, va creato una volta con `sudo install -d -o 1000 -g 1000 -m 700 /srv/media/.gigi-trash`, altrimenti cestinare dà «Permesso negato».

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

## Flussi

Automazioni → **Flussi**: ogni flusso è un insieme di blocchi collegati. Si parte da un blocco di **ricezione**, si passa per la **logica** e si arriva alle **azioni**. I flussi nuovi nascono spenti; si attivano dall’editor o dall’elenco.

| Ricezione | Logica | Azioni |
|---|---|---|
| Avvio manuale (con dati di prova) | Filtro (se / allora, più condizioni) | Notifica sui canali configurati |
| **Webhook in entrata** (token segreto) | Scegli strada (più uscite) | Richiesta HTTP verso un’API |
| Pianificazione (ogni N minuti, ogni giorno, giorni della settimana, una volta) | Imposta campi | **Cerca torrent** (lingua, qualità, dimensione, seed) |
| Evento di GIGI OS (Docker, download, media, aggiornamenti…) | **Attendi** (per un tempo o fino a una data, anche «N ore prima») | Aggiungi a qBittorrent |
| Controlla un’API JSON (elementi nuovi) | Ignora doppioni | C’è già in Jellyfin? |
| GitHub (commit, issue con etichetta, pull request, release, un file che cambia) | **Chiedi conferma** (pulsanti su Telegram e qui) | Scansione Jellyfin |
| Feed RSS / Atom | | Avvia o riavvia un container consentito |
| Comando Telegram (es. `/film Matrix`) | | Scrivi un evento |

- **Editor:** aggiungi i blocchi dalla colonna a sinistra, collega un’uscita (pallino a destra) all’ingresso di un altro blocco, clicca un blocco per configurarlo. Non sono ammessi cicli né ingressi nei blocchi di ricezione.
- **Espressioni:** nei campi si scrivono i dati dei passi precedenti tra doppie graffe, con [JSONata](https://docs.jsonata.org/overview): `{{ json.title }}` (dati attuali), `{{ trigger.body.date }}` (cosa è arrivato), `{{ node.NomeBlocco.campo }}`. Niente codice JavaScript; ogni espressione ha limiti di tempo e di profondità.
- **Esegui ed Esecuzioni:** «Esegui» prova il flusso con i dati di prova o con l’ultimo evento ricevuto. In «Esecuzioni» si vede cosa è entrato e uscito da ogni blocco, e i blocchi si colorano con l’esito.
- **Attese e conferme** restano salvate anche se GIGI OS si riavvia. Le conferme arrivano su Telegram agli account collegati con ruolo operatore o amministratore, e compaiono in Automazioni → Flussi: vale la prima risposta. Un’esecuzione interrotta a metà da un riavvio risulta in errore.
- **Limiti:** al massimo 60 esecuzioni ogni 10 minuti per flusso, 200 passi per esecuzione, 4 esecuzioni contemporanee; storico di 30 giorni (200 esecuzioni per flusso).
- **Permessi:** creare, modificare ed eseguire i flussi è da amministratore; rispondere alle conferme anche da operatore. Ogni modifica va nell’audit.

**Webhook in entrata.** Ogni blocco webhook ha il suo indirizzo `https://<GIGI_BIND>:8470/api/v1/hooks/<flusso>/<blocco>` e un token generato da GIGI OS, mostrato una sola volta (nel database ne resta solo l’impronta). Il chiamante manda `POST` o `PUT` con corpo JSON e `Authorization: Bearer <token>`; il token nell’indirizzo non vale. Risponde `202`. Il webhook è raggiungibile solo dalla rete locale o dalla VPN, perché GIGI OS ascolta solo lì. Il certificato è autofirmato: chi chiama deve fidarsi di `secrets/tls.crt` (o, per le prove, usare `curl -k`). Anche a flusso spento l’ultimo evento ricevuto viene salvato e mostrato nell’editor, con i campi pronti da copiare: così le espressioni si scrivono sul formato vero del servizio esterno. Le chiamate dal browser (CORS) non sono supportate: deve chiamare il server del servizio.

**Modello «Borollo: film confermato».** Webhook → «Confermato?» → «Dati del film» (titolo, anno, data) → «Già in libreria?» (se c’è: notifica) → «Fino a 3 giorni prima» della data → «Cerca in italiano» → «Quale scarico?» (le 3 versioni migliori come pulsanti) → «Scarica» in qBittorrent, categoria Film → notifica. Poi il motore media lo importa in Jellyfin come sempre. I campi `status`, `title`, `year` e `date` del modello sono ipotesi: dopo il primo evento di prova di Borollo si adattano nei blocchi «Confermato?» e «Dati del film». Gli altri modelli: «/film da Telegram» e «Avvisami quando un titolo è pronto». Scarica solo ciò che hai diritto di scaricare: la ricerca usa i plugin già installati in qBittorrent.

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
docker compose build && docker compose up -d   # dopo modifiche locali al codice (per le versioni: sudo ./update.sh)
docker compose stop               # fermare GIGI OS (gli altri servizi non ne risentono)
npm test                          # test unitari e di integrazione (serve Node 22 sull'host)
```

### Aggiornare GIGI OS

Quando esce una versione nuova (un tag `vX.Y.Z` su GitHub), la pagina **Aggiornamenti** la mostra con il comando da copiare, e arrivano l’evento «aggiornamenti» e la riga nel digest. Il controllo usa la repo in `GIGI_RELEASE_REPO` (l’installer la ricava dal repository da cui hai clonato).

```sh
sudo ./update.sh --check     # c'è una versione nuova? (esce con 10 se sì)
sudo ./update.sh             # aggiorna all'ultima versione, dopo una conferma
sudo ./update.sh --dry-run   # mostra cosa farebbe
sudo ./update.sh --version 0.3.0   # va a una versione precisa, anche precedente
```

Cosa fa, in ordine: scarica tag e codice con git (come proprietario della cartella), si ferma se trova file del repository modificati a mano o commit locali che la versione non contiene, porta il codice alla versione, aggiorna `GIGI_VERSION` e aggiunge al `.env` le chiavi nuove (con `install.sh`, che non sovrascrive niente), **costruisce le immagini mentre GIGI OS continua a funzionare** (o le scarica, con `GIGI_IMAGE_PREFIX`), ferma API e worker media, copia `./data` in `backups/update-<da>-to-<a>-<data>/` e riavvia **solo** lo stack `gigi-os`.

Se la nuova versione non diventa sana entro due minuti, torna da solo alla precedente: rimette codice, versione e dati di prima (quelli del tentativo restano in `backups/update-failed-…`). Se la costruzione delle immagini fallisce, non viene riavviato niente. Le copie in `backups/update-*` si possono cancellare a mano dopo qualche giorno; le immagini delle versioni vecchie restano per un eventuale ritorno (`docker image ls '*gigi-os*'`).

Tornando a una versione precedente con `--version`, i dati restano quelli attuali: se la versione nuova aveva cambiato il database, rimetti la copia `backups/update-…` fatta prima di aggiornare (a stack fermo). `--main` segue il ramo `main` invece delle versioni pubblicate (solo per chi sviluppa).

**Pubblicare una versione** (per chi mantiene la repo): aggiorna `version` in `package.json` (e `npm install --package-lock-only`), aggiungi la sezione in `CHANGELOG.md`, poi `git tag vX.Y.Z && git push origin main vX.Y.Z`. Il workflow di release verifica che il tag coincida con `package.json`, pubblica le immagini su GHCR e crea la release con le note del CHANGELOG.

### Backup

Da salvare, **separatamente**:
- `secrets/master.key`: senza questa chiave le credenziali salvate non sono recuperabili.
- `data/gigi.sqlite`: utenti, integrazioni, layout, audit, storico delle metriche. Fai la copia a stack fermo, oppure con `sqlite3 data/gigi.sqlite ".backup copia.sqlite"`.

### Rollback

Lo stack è autonomo. Per rimuoverlo completamente:

```sh
docker compose down                                  # solo lo stack gigi-os
ufw delete allow from 192.168.222.0/24 to any port 8470 proto tcp
```

## Porte, variabili, permessi

- **Porta:** 8470/tcp sull'IP LAN, HTTPS. Nessuna altra porta: l'agent comunica solo tramite socket Unix.
- **Variabili:** vedi `.env.example`, che le descrive tutte. Nel file `.env` non ci sono segreti. Obbligatoria solo `GIGI_BIND` (IP LAN del server). Le reti consentite ai connettori, se `GIGI_ALLOWED_TARGETS` è vuota, sono 127.0.0.1 più la rete LAN di quell'IP. Le cartelle (`GIGI_MEDIA_ROOT`, `GIGI_MEDIA_LIBRARIES`, `GIGI_FILES_ROOTS`, `GIGI_STACKS_ROOT`) non sono più scritte in `compose.yaml`. `GIGI_METRICS_DAYS` (predefinito 30) stabilisce quanti giorni di storico conservare: circa 15 MB per 30 giorni.
- **Impostazioni di questo server:** `compose.override.yaml` (caricato in automatico da `docker compose`) aggiunge i mount specifici dell'host, come le configurazioni di qBittorrent e Jellyfin da includere nei backup. Per un'altra installazione si parte da `compose.override.example.yaml`.
- **Host diversi da Ubuntu:** senza systemd, journal, apt o UFW le sezioni corrispondenti mostrano «non disponibile» invece di un errore.
- **Rete:** `gigi-api` monta in sola lettura `/run/systemd/resolve` (DNS reali dell’host) e contiene `ping` e `tracepath` (ICMP non privilegiato, nessuna capability). Le regole UFW si vedono solo se installi il timer di sola lettura: `sudo sh scripts/host/install-ufw-snapshot.sh` (rimozione con `--uninstall`); scrive `data/host/ufw-status.txt` ogni 5 minuti.
- **Stack del wizard:** in `/opt/stacks/<cartella>` (proprietario `gigi`): `compose.yaml`, `compose.yaml.prev` (versione precedente), `.env` (0600) e `.gigi-stack.json` (marcatore: solo le cartelle che lo contengono sono gestibili da GIGI OS). Per aggiungere altre radici: `GIGI_STACK_ROOTS` e un mount con lo **stesso percorso** nell’agent, cartella scrivibile dall’utente 1000.
- **Permessi:** `gigi-media` monta `/srv` in scrittura (unico modo per creare hardlink tra download e librerie), più `./data/media`. Il codice non elimina, non sposta e non sovrascrive mai file. Gira come utente 1000: le cartelle delle librerie devono essere scrivibili da quell’utente. `gigi-agent` monta `docker.sock` (accesso equivalente a root sull'host), `/opt/stacks` in scrittura e in sola lettura `/etc/os-release` e `/etc/hostname`; contiene il binario ufficiale `docker-compose` v5.6.0 (Apache-2.0). Per il controllo aggiornamenti legge in sola lettura `/var/lib/update-notifier`, `/var/lib/apt/periodic` e `/boot`. **Nota:** chi è admin di GIGI OS può avviare stack con privilegi arbitrari, quindi l’account admin equivale a root sull’host: usa una password robusta e non condividerlo. `gigi-api` monta `./data`, `./secrets` (in sola lettura) e il volume del socket. Entrambi girano come utente 1000, con filesystem in sola lettura, senza capability e con `no-new-privileges`.
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
