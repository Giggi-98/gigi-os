import { jellyfin } from './jellyfin.js';
import { qbittorrent } from './qbittorrent.js';
import { apollo, armony, genericHttp, homeassistant, navidrome } from './others.js';
import type { ConnectorDef } from './types.js';

export const connectors: Record<string, ConnectorDef> = Object.fromEntries(
  [jellyfin, qbittorrent, navidrome, homeassistant, armony, apollo, genericHttp].map((c) => [c.type, c]),
);

/** Integrazioni senza credenziali create automaticamente al primo setup. */
export const AUTO_SEED = ['apollo', 'armony', 'navidrome'];
