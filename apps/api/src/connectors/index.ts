import { jellyfin } from './jellyfin.js';
import { qbittorrent } from './qbittorrent.js';
import { apollo, armony, genericHttp, homeassistant, navidrome } from './others.js';
import type { ConnectorDef } from './types.js';

export const connectors: Record<string, ConnectorDef> = Object.fromEntries(
  [jellyfin, qbittorrent, navidrome, homeassistant, armony, apollo, genericHttp].map((c) => [c.type, c]),
);

/** Integrazioni senza credenziali create automaticamente al primo setup. */
// Nessuna integrazione creata da sola: ogni installazione aggiunge quelle che ha (Armony e Apollo sono app specifiche).
export const AUTO_SEED: string[] = [];
