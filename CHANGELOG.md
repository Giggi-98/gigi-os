# Novità

Ogni versione ha un tag `vX.Y.Z`. Il workflow di release copia nella pagina della release la sezione con lo stesso numero.
Per aggiornare un server: `sudo ./update.sh` nella cartella di GIGI OS (vedi LEGGIMI.md).

## [Non rilasciato]

- GitHub: la release pubblica le immagini con il proprietario in minuscolo (GHCR lo richiede) e si può riavviare a mano per un tag già pubblicato; la CI usa Trivy fissato a un commit e riporta ogni vulnerabilità come annotazione.
- Immagini più sicure e leggere: aggiornamenti di sicurezza di Debian/Alpine applicati in build (es. `liblzma5`), npm, npx, corepack e yarn tolti dalle immagini finali.
- Docker Compose dell’agent ricompilato dai sorgenti ufficiali v5.6.0 con Go 1.26.9 e golang.org/x/net 0.60.0 (il binario pubblicato aveva 4 vulnerabilità alte già corrette).

## [0.3.1] — 2026-10-17

Aggiornamento da 0.3.0: `sudo ./update.sh` (applica da solo la migrazione 008 del database; copia dei dati in `backups/update-0.3.0-to-0.3.1-…`).

- **Flussi** in Automazioni: editor grafico stile n8n con blocchi di ricezione (webhook con token, API JSON, GitHub, RSS, pianificazione, eventi di GIGI OS, comandi Telegram), logica (filtri, strade, attese fino a una data, doppioni, conferme con pulsanti su Telegram) e azioni (notifiche, HTTP, ricerca e download torrent, Jellyfin, container). Storico di ogni esecuzione blocco per blocco. Modelli pronti: «Borollo: film confermato», «/film da Telegram», «Avvisami quando un titolo è pronto».
- **Controllo libreria** in Media: titoli rimasti in Jellyfin e Apollo senza più un torrent (con «Elimina») e schede di Jellyfin senza file (con «Togli da Jellyfin»).
- Un titolo eliminato sparisce da Jellyfin anche quando era l’ultimo della sua libreria (Jellyfin salta le cartelle vuote nella scansione); «Aggiunti di recente» si aggiorna da solo.
- Eliminando un torrent «con i file scaricati», avviso se il titolo resta in libreria e quindi in Jellyfin e Apollo.

## [0.3.0] — 2026-10-16

Prima versione pubblica.

- **Aggiornamento in un comando:** `sudo ./update.sh` scarica l’ultima versione, ricostruisce le immagini, salva una copia dei dati e, se la nuova versione non parte, torna da sola alla precedente. La pagina Aggiornamenti e il digest avvisano quando esce una versione nuova.
- **Elimina dalla libreria:** da Media si cerca un film, una serie o un episodio e lo si toglie (cestino o definitivo), insieme ai torrent con gli stessi file; sparisce da Jellyfin e Apollo in pochi secondi. «Elimina ovunque» trova le copie in libreria anche se importate prima di GIGI OS e dice prima cosa sparirà.
- **Dispositivi fidati per la verifica in due passaggi:** «Ricorda questo dispositivo» al login, per un periodo scelto dall’amministratore (da 1 a 90 giorni, oppure mai).
- **Installazione su qualsiasi server:** `install.sh` rileva IP, gruppi, fuso orario e configurazioni di Jellyfin e qBittorrent; nessun valore di un server specifico nel codice.
- **Interfaccia in italiano e inglese** (menu, componenti comuni, login, 2FA, dashboard; le altre pagine sono ancora in italiano).
- **Rilevamento aggiornamenti:** immagini dei container, nuove versioni per i tag fissati, sistema operativo, Jellyfin, Home Assistant e GIGI OS.
- Ruolo operatore e 2FA obbligatoria per amministratori e operatori; bot Telegram e digest; launcher delle app e ricerca Ctrl+K; storico di 30 giorni con previsione dei dischi.
- Già presenti: dashboard, Docker (container, stack compose, pulizia), rete, file manager, download con qBittorrent, importazione automatica in Jellyfin, automazioni e notifiche, backup, integrazioni.
