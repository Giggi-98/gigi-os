# Linee guida di progetto — GIGI OS

> Istruzioni persistenti per Claude Code. Obiettivo: costruire un control center self-hosted per il mini PC Ubuntu **Gigi-Mini-Pc**, combinando funzioni di Cockpit, Homarr e Portainer con un motore di automazione multimediale. Queste linee guida privilegiano sicurezza, semplicità e verificabilità rispetto alla velocità.

## 0. Il progetto in breve

**GIGI OS** è un'applicazione web originale, modulare e self-hosted: un unico luogo da cui osservare, gestire e collegare il server, Docker, i servizi e i flussi multimediali. Deve usare **librerie, SDK e componenti open source con licenze compatibili**, non essere una collezione di iframe o un fork incontrollato.

Due aree funzionali, nella stessa UI ma con responsabilità separate:

1. **Homelab Control Center:** stato hardware, processi e servizi consentiti, container, log, volumi, storage, notifiche, widget personalizzabili, integrazioni mediante API/chiavi/token e operazioni amministrative protette.
2. **Intelligent Media Automation:** qBittorrent → verifica completamento → classificazione tramite filename/metadati/provider → importazione sicura nelle directory esistenti → scansione e verifica Jellyfin → disponibilità attraverso Apollo.

**Prima di scrivere codice o modificare il server:** leggi questo file, ispeziona il repository e consulta `LEGGIMI.md` e `DECISIONS.md` *se esistono*. Se non esistono, proponi di crearli al momento di avviare lo sviluppo. La documentazione non sostituisce la verifica del codice e dell'installazione reale: se divergono, segnalalo.

### Stato noto dell'host (snapshot del 15 ottobre 2026)

- Host: `Gigi-Mini-Pc`; Ubuntu headless; gestione SSH; Docker.
- Percorso Jellyfin visto in passato: `/opt/docker/jellyfin/config/data/jellyfin.db` (da verificare; **mai scrivere direttamente nel DB Jellyfin**).
- Il comando `docker ps` ha mostrato questi container **in esecuzione**, non necessariamente tutti quelli presenti:

| Container | Immagine | Note note |
|---|---|---|
| `jellyfin` | `jellyfin/jellyfin:latest` | healthy; libreria multimediale esistente |
| `apollo` | `apollo-jellyfin` | healthy; porta host `4173/tcp`; app custom legata a Jellyfin |
| `qbittorrent` | `lscr.io/linuxserver/qbittorrent:latest` | torrent `6881/tcp+udp`; Web UI `192.168.222.200:8085` |
| `armony-app` | `armony-armony` | applicazione custom **dell'utente**; non sostituire |
| `homeassistant` | `ghcr.io/home-assistant/home-assistant:stable` | attivo |
| `armony-https` | `caddy:2.8.4` | reverse proxy/HTTPS di Armony: verificarne la configurazione |
| `armony-pot` | `brainicism/bgutil-ytdlp-pot-provider:latest` | `127.0.0.1:4416` |
| `armony-navidrome` | `deluan/navidrome:0.64.2` | `127.0.0.1:4533`; serve Armony |

**Assenti/rimossi:** Cockpit, Homarr, Sonarr, Prowlarr e Radarr. **Non reinstallarli automaticamente.** Portainer è un riferimento funzionale, non un prerequisito; verificare se presente prima di trarre conclusioni. L'assenza di un container in `docker ps` non dimostra che non esistano un servizio host o un container fermo: ispeziona senza modificare.

**Armony** è sviluppata dall'utente e comunica con Navidrome. **Apollo** è un container custom `apollo-jellyfin`: non confonderlo con software omonimi; ispeziona le API e la relazione con Jellyfin prima di progettare l'integrazione. **GIGI OS non deve diventare una dipendenza necessaria per far funzionare queste app.**

### Inventario e percorso del repository

Non inventare layout o file già esistenti. All'inizio ispeziona `pwd`, `git status`, directory, compose, documentazione e configurazione. Uno **schema da proporre, non da presumere**, è:

```text
CLAUDE.md                istruzioni per gli agenti
LEGGIMI.md               guida utente, installazione, funzionalità reali
DECISIONS.md             registro architetturale delle scelte
.env.example             nomi/configurazione delle variabili, mai segreti veri
compose.yaml             esclusivamente stack di GIGI OS
apps/web/                frontend dashboard
apps/api/                API applicative e connettori
apps/worker/             media automation e job asincroni
packages/shared/         tipi/contratti riutilizzati, solo se serve
migrations/              migrazioni append-only
scripts/                 operazioni ripetibili e sicure
tests/                   unit, integration, end-to-end
data/                    stato persistente non tracciato in Git
```

Se il repository ha già una struttura, rispettala. Non scegliere strumenti o creare cartelle solo perché compaiono nello schema.

## 1. Prima pensa, poi modifica

**Non presumere, non nascondere dubbi, rendi espliciti i tradeoff.**

- Ogni intervento parte da un obiettivo verificabile, dalla lettura dei file interessati e dalla mappa delle dipendenze.
- Distingui sempre: **fatti verificati / ipotesi / proposta / lavoro implementato e testato**.
- Se esistono approcci alternativi, raccomanda quello più semplice e spiega cosa si sacrifica.
- Chiedi conferma quando una scelta è ambigua e potrebbe essere irreversibile, rischiosa o cambiare comportamento esistente; non fare domande inutili per dettagli deducibili.
- Per nuove installazioni, modifica delle porte, firewall, permessi, mount, migrazioni rischiose e sostituzione di servizi: **presenta piano, impatto, backup e rollback prima di eseguire**.
- **Primo avvio del progetto:** fase di audit **read-only**, poi proposta di architettura e MVP. Nessuna installazione automatica durante l'audit.

## 2. Semplicità prima di tutto

**Scrivi il minimo codice affidabile che risolve il problema richiesto.**

- Non realizzare contemporaneamente tutte le funzionalità di Cockpit, Homarr e Portainer.
- Parti da un **monolite modulare + eventuale worker isolato**; non inventare microservizi senza necessità misurabile.
- SDK Docker, librerie di parsing, API ufficiali e componenti UI maturi vengono prima di implementazioni proprietarie.
- Nessuna astrazione per un solo caso d'uso, nessun framework plugin prematuro oltre ai contratti necessari per i connettori effettivi.
- Non aggiungere dipendenze pesanti, polling frequenti o modelli AI locali senza misurare le risorse del mini PC.
- Non proporre React/Vite/Python come obbligatori: valuta stack e licenze sulla base del repo e dei vincoli reali. Una volta scelta e registrata l'architettura, non cambiarla casualmente.
- Non presentare mock come dati live; indica esplicitamente le eventuali demo.

## 3. Modifiche chirurgiche e isolamento

**Tocca solo ciò che serve. Ripulisci solo ciò che introduci.**

- Non rifattorizzare codice adiacente non pertinente e non cambiare la formattazione di interi file.
- Conserva le convenzioni già adottate, i contratti API e i dati persistenti.
- Ogni nuova dipendenza o permesso deve avere una motivazione concreta.
- Non eseguire `docker compose down` su stack altrui, `docker system prune`, `rm -rf`, cancellazioni di volumi o aggiornamenti indiscriminati.
- Non ricreare né interrompere `jellyfin`, `apollo`, `qbittorrent`, `armony-app`, `homeassistant`, `armony-https`, `armony-pot`, `armony-navidrome` per sviluppare GIGI OS.
- GIGI OS gira nel **proprio stack**, con volumi e network deliberati; i servizi esistenti continuano a funzionare quando GIGI OS è fermo.
- I permessi di Docker e dei file sono accessi sensibili. Evita socket Docker esposto al browser o a processi non fidati; isola le azioni privilegiate e limita quelle disponibili.

## 4. Moduli di prodotto e confini

### Dashboard e stato del sistema

Homepage unica e personalizzabile: CPU, RAM, dischi, rete, temperature se disponibili, uptime, salute container, download, nuovi media, errori e collegamenti app. Widget ridimensionabili solo quando il layout persistente è pronto. Gestisci esplicitamente stati loading, vuoto, offline e errore.

### Docker e host

Usa Docker Engine API/SDK (non scraping della CLI) per elenco, inspect, metriche, eventi e log; le azioni start/stop/restart richiedono autorizzazione. Per systemd, filesystem, update e processi usa adapter host limitati e verificabili, non un endpoint che esegue shell arbitraria. Nessun endpoint pubblico può comandare Docker.

### Integration Hub

Ogni connettore reale ha: configurazione, test connessione, health, capability dichiarate, timeout, retry moderati e azioni autorizzate. Priorità: Docker, Jellyfin, qBittorrent, Navidrome, Home Assistant, Armony e Apollo. **Non presupporre che Armony o Apollo espongano API amministrative**: verificarlo. Supporta API key, token, password e OAuth solo secondo quanto supportato dal servizio e da una gestione sicura dei segreti. Non usare password e token nelle URL o nei log.

### Media automation

Pipeline dei contenuti che l'utente ha diritto di scaricare e utilizzare:

```text
qBittorrent: download completo
  -> evento/API e stabilità verificata
  -> inventario file, MediaInfo/ffprobe e filename parsing
  -> matching provider metadata legittimi, con rate limit
  -> classificazione film / serie / anime / speciali
  -> controllo duplicati + soglia di confidenza
  -> dry-run destinazione
  -> importazione idempotente (hardlink se possibile)
  -> aggiornamento/scansione via API Jellyfin
  -> verifica indicizzazione
  -> visibilità nell'esperienza Apollo, verificata in base alla sua API reale
```

- Riusare le **librerie di classificazione**, non clonare l'intero comportamento *arr senza un motivo.
- I metadati interni a un file **non garantiscono** titolo, stagione e puntata: combinare nome file, cartella, struttura release e provider esterni, segnalando l'incertezza.
- Soglia alta: importa; media: cerca ulteriore evidenza; bassa: coda di revisione, non spostare o cancellare.
- Gestire nomi fansub, episodi multipli, special, OVA/ONA, sottotitoli esterni, titoli omonimi e release duplicate in modo esplicito.
- **Seeding:** non spostare distruttivamente file ancora necessari a qBittorrent. Verificare mount e device filesystem prima degli hardlink; se non possibili, mostra costi delle copie e richiedi conferma per operazioni costose.
- Sorgente e destinazione reali vanno scoperte: non imporre una nuova tassonomia che confligge con le librerie Jellyfin già funzionanti.
- Non scrivere in `jellyfin.db`: solo API/interfacce documentate e rescansioni appropriate.
- Nessun file ancora incompleto può finire in libreria. Retry e ripartenze non devono creare duplicati.

### File manager e automazioni

File manager confinato a path consentiti, protezione da traversal/symlink escape, conferma per operazioni massive. Workflow su eventi verificati, coda persistente, job idempotenti, limiti di concorrenza, storico, notifiche; un editor visuale stile Node-RED è **fase successiva**, non prerequisito del primo MVP.

## 5. Sicurezza come requisito funzionale

GIGI OS sarà un pannello ad alti privilegi: **sicurezza fin dal primo endpoint**.

- Autenticazione robusta, sessioni sicure, CSRF ove applicabile, validazione input, rate limiting, audit log; prevedere almeno ruoli `admin` e `read-only`.
- Verifica autorizzazioni **nel backend per ogni azione**, non solo nascondendo pulsanti.
- Accesso iniziale su LAN/VPN; niente porte pubbliche, forwarding o cambi UFW senza consenso. Proteggi anche WebSocket e streaming dei log.
- Segreti cifrati a riposo con chiave non salvata nello stesso database; `.env` non tracciato e `.env.example` senza valori reali. Tratta le credenziali come segreti anche nei crash report, negli export e negli screenshot.
- Connessioni API configurabili possono indurre **SSRF**: limita protocolli, destinazioni e redirect secondo modello di fiducia esplicito, senza bloccare per errore gli endpoint LAN legittimi autorizzati.
- Socket Docker: accesso praticamente equivalente a root. Preferisci agente isolato e operazioni allowlist, con threat model documentato. Non spacciare un semplice socket proxy per isolamento totale.
- Dipendenze open source: verifica licenze, manutenzione, vulnerabilità note e obblighi di attribuzione. Non copiare UI o codice incompatibile.
- Privilegi minimi, mount read-only quando possibile, niente container `privileged` di default.

## 5a. Persistenza, API e compatibilità

- Database e state directory dedicati a GIGI OS, mai riutilizzare DB privati di Armony/Jellyfin per modificarli.
- Migrazioni **numerate e append-only** dopo il primo rilascio: mai riscrivere una già distribuita; backup e strategia rollback per cambi schema.
- API versionate e contratti dichiarati. Un connettore che perde accesso deve degradare singolarmente, non bloccare dashboard e altri servizi.
- Distingui `unhealthy`, `offline`, `non configurato`, `accesso negato` e `non supportato`.
- Retry con backoff, timeout, logging strutturato con rotazione, deduplicazione e limiti di retention; mai loop incontrollati.
- Lo stack GIGI OS deve ripartire dopo reboot senza interventi e **senza interferire** con i container esistenti.

## 5b. Documentazione e registro decisioni

**Quando cambi una funzione visibile all'utente, aggiorna `LEGGIMI.md` nello stesso commit** (se il file esiste; altrimenti crealo quando parte il progetto). Aggiorna anche documentazione per porte, variabili, nuovi connettori, permessi e istruzioni di deploy. Scrivi in italiano chiaro.

**Ogni scelta architetturale che esclude un'alternativa va in `DECISIONS.md`**: data, contesto, scelta, alternative scartate, conseguenze, **«Da rivedere se»**. Le voci già adottate sono append-only; per ribaltare una scelta creane una nuova che rimandi alla precedente. Leggile prima di proporre stack o rifattorizzazioni strutturali.

Se si crea un repository Git pubblico:

- `.gitignore` deve escludere `.env`, chiavi, token, state, backup e dati utente.
- Protezioni pre-commit/secrets scan consigliate, ma non inventare hook già presenti.
- **Non creare né pushare tag, release o deploy in produzione senza richiesta esplicita.**
- Ogni comando che può rendere indisponibile un servizio reale richiede valutazione e autorizzazione.

## 6. Goal-driven execution e test

**Definisci il criterio di successo prima di codificare. Completa ogni modifica con una prova proporzionata.**

Per lavori multi-step, fornisci un piano breve:

```text
1. Ispeziona componenti coinvolti -> verifica: configurazione confermata
2. Implementa modifica minima -> verifica: test mirato e nessuna regressione
3. Controlla UI/API in esecuzione -> verifica: scenario reale e report
```

Test da predisporre/manutenere secondo lo stack effettivo:

- unit: parser nomi, classificazione, soglie, autorizzazioni, mapping path, utilità;
- integration: connettori con mock e, quando sicuro, API read-only reali;
- Docker: log, status e API su container non critici di test, mai prove distruttive sui servizi utente;
- media e2e: **torrent/file di test legittimo**, verifica completamento, preservazione sorgente/seeding, import, Jellyfin, casi ambigui, retry e duplicati;
- security: authN/authZ, SSRF, traversal, CSRF, secret redaction, escalation di privilegi;
- resilienza: disconnessione provider, riavvio worker, riavvio host (solo con consenso), job ripetuti;
- UI: navigazione tastiera, errori, dati grandi, responsive e contrasto.

Non dichiarare «funziona» senza aver eseguito un controllo. Se un test non è possibile, specifica chiaramente cosa non è verificato.

## 7. Lavoro di interfaccia

**Una modifica UI non è verificata finché non è stata renderizzata e osservata.**

- Dark mode predefinito, light mode opzionale; densità informativa equilibrata, sidebar, widget, tabelle accessibili e grafici leggibili.
- Riferimenti di qualità: Linear, Vercel, Homarr, Portainer, Grafana; **non copiare identità, asset o codice senza diritto**.
- Usa token design (colori, spaziatura, tipografia, radii), componenti condivisi e stati semanticamente coerenti.
- Verifica con browser/Playwright, se disponibili: dashboard carica, vuota, offline, errore, molti container, configurazione credenziali oscurate, tablet e telefono, entrambi i temi.
- Niente grafici meramente decorativi o dati fittizi spacciati per telemetria.
- Evita widget che rinfrescano continuamente senza visibilità; usa eventi o polling moderato quando necessario.
- Per ogni interazione pericolosa: conferma, descrizione dell'impatto, feedback e audit trail.
- Correggi problemi visivi con iterazioni mirate, non riscrivere il design a ogni screenshot.

## 8. Roadmap e priorità

**Fase 0 — Audit read-only.** `docker ps -a`, inspect mirati, mount, filesystem, network, porte, compose, stato host, risorse, API disponibili e directory media. Maschera i segreti in output e report. Non installare nulla.

**Fase 1 — Decisioni/MVP.** Valuta componenti open source e licenze, decidi stack, schema di permessi, storage, architettura e rollback. Presenta un MVP realizzabile e chiedi approvazione per modifiche di sistema.

**Fase 2 — Core.** Login, frontend coerente, API, storage, dashboard con metriche vere, monitoraggio container e log read-only.

**Fase 3 — Controllo e integrazioni.** Operazioni Docker autorizzate, vault credenziali, connettori Jellyfin/qBittorrent/Navidrome/Home Assistant, e integrazioni Armony/Apollo secondo le capacità reali.

**Fase 4 — Media engine.** Workflow torrent → classificazione → review → importazione sicura → sync/verifica Jellyfin → esperienza Apollo.

**Fase 5 — Espansioni.** File manager, alert, workflow visuali, backup, aggiornamenti e altri connettori, solo in base alla priorità reale.

## 9. Guardrail operativi non negoziabili

1. Durante il primo audit **solo lettura**; non cambiare configurazioni o installare software.
2. Non fermare, ricreare, rinominare o aggiornare servizi esistenti senza autorizzazione.
3. Non alterare Armony, Apollo, Navidrome o le librerie Jellyfin per adattarle a GIGI OS: integra tramite interfacce stabili.
4. Non toccare UFW, SSH, DNS, Caddy, certificati, IP o porte di altri servizi senza piano e consenso.
5. Non cancellare media, torrent, database, volumi, immagini o backup senza richiesta esplicita.
6. Nessun `docker compose down` globale, nessun `docker system prune`, nessun `chmod -R` indiscriminato.
7. Nessun secret in Git, nella UI non mascherata, in log, report, comandi riportati o screenshot.
8. Non inventare API, path, mount, credenziali, capability o risultati dei test.
9. Non esporre operazioni root senza confini di privilegi verificabili.
10. Ricorda: **il mini PC è un sistema vivo**, non un ambiente usa-e-getta.

## 10. Formato della risposta e definizione di completamento

Comunica in **italiano**, con sintesi e precisione. A fine task riporta:

1. **Fatti scoperti** (solo verificati).
2. **Cosa hai cambiato** (file e comportamento) oppure proposta se non autorizzato.
3. **Test eseguiti e risultati**.
4. **Rischi, limiti, elementi non verificati**.
5. **Prossimo passo più utile**.

**GIGI OS è pronto per un rilascio solo quando** la dashboard mostra dati reali, i connettori falliscono in modo controllato, la sicurezza è testata, i container preesistenti restano autonomi, e l'intera pipeline media conserva i torrent e importa correttamente in Jellyfin. Le funzionalità non ancora sviluppate devono comparire come tali, non come complete.

### Istruzione per la prima sessione

**Inizia con audit read-only del server e del repository.** Riporta inventario, mount media, API effettivamente disponibili, hardware, rischi, stack consigliato, licenze dei componenti da riutilizzare e perimetro del primo MVP. **Attendi approvazione prima di installare, scrivere configurazioni dell'host o avviare deploy.**
