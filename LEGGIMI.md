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
| Sistema | Storico di CPU, RAM e rete (ultima ora), utilizzo per core, temperature, dischi, interfacce | Dati letti da /proc e /sys, nessun dato simulato |
| Docker | Container (ricerca, filtri, ordinamento), dettaglio, healthcheck, mount, rete, variabili d'ambiente oscurate, log in diretta, immagini, volumi, reti | Avvio/stop/riavvio solo per gli admin, con conferma digitando il nome; `gigi-agent` e `gigi-api` sono protetti |
| Media | Jellyfin (librerie, conteggi, scansioni, sessioni, ultimi aggiunti), Apollo (stato), qBittorrent (torrent, velocità, categorie) | Richiede le credenziali di Jellyfin e qBittorrent (vedi sotto) |
| Armony | Stato di Armony (`/api/info`), Navidrome, stack `armony` | Sola lettura: Armony non viene modificata |
| Integrazioni | Aggiunta, verifica, modifica e rimozione dei connettori; credenziali cifrate | Jellyfin, qBittorrent, Navidrome, Home Assistant, Armony, Apollo, HTTP generico |
| Sicurezza | Cambio password, sessioni attive, utenti e ruoli, audit log, modello di sicurezza | Ruoli: amministratore e sola lettura |

**Non ancora disponibili** (in barra laterale come «presto», senza alcuna operazione attiva): media automation, file manager, automazioni, backup, gestione di systemd e journal.

## Collegare i servizi

Vai su **Integrazioni** e usa i pulsanti «Suggerite». Apollo, Armony e Navidrome (solo health) vengono creati in automatico al primo setup.

| Servizio | Credenziale | Dove ottenerla |
|---|---|---|
| Jellyfin | API key | Dashboard Jellyfin → Chiavi API → «+» (nome: GIGI OS) |
| qBittorrent | **API key** (consigliata, qBittorrent ≥ 5.2), in alternativa utente e password | Opzioni → Web UI → API key (inizia con `qbt_`) |
| Home Assistant | Long-lived access token | Profilo → Sicurezza → Token di accesso a lunga durata |
| Navidrome (facoltativo) | Utente Subsonic | Un utente Navidrome, meglio se non amministratore |

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
- **Permessi:** `gigi-agent` monta `docker.sock` (accesso equivalente a root sull'host) e in sola lettura `/etc/os-release` e `/etc/hostname`. `gigi-api` monta `./data`, `./secrets` (in sola lettura) e il volume del socket. Entrambi girano come utente 1000, con filesystem in sola lettura, senza capability e con `no-new-privileges`.
- **Risorse:** circa 50 MB di RAM in totale a riposo (limiti: 160 MB agent, 256 MB API).

## Struttura

```text
apps/agent   processo privilegiato: metriche /proc e /sys, Docker Engine API (dockerode), log oscurati
apps/api     Fastify: auth, RBAC, CSRF, vault, connettori, audit, eventi, UI statica
apps/web     React + Vite + Tailwind: interfaccia
tests        test unitari e di integrazione (node --test)
scripts      init-secrets.sh (chiave master e certificato, idempotente)
```

Le scelte architetturali sono in `DECISIONS.md`; le regole di lavoro per gli agenti sono in `CLAUDE.md`.
