import { ConnectorError, expectOk, json, type ConnectorContext, type ConnectorDef } from './types.js';

const CLIENT = 'MediaBrowser Client="GIGI OS", Device="gigi-os", DeviceId="gigi-os", Version="0.1.0"';

function headers(ctx: ConnectorContext): Record<string, string> {
  const key = ctx.secret.apiKey;
  return { Authorization: key ? `${CLIENT}, Token="${key}"` : CLIENT, Accept: 'application/json' };
}

async function get<T>(ctx: ConnectorContext, path: string, what: string): Promise<T> {
  return json<T>(expectOk(await ctx.http(path, { headers: headers(ctx) }), what));
}

type Item = {
  Id: string;
  Name: string;
  Type: string;
  SeriesName?: string;
  ParentIndexNumber?: number;
  IndexNumber?: number;
  ProductionYear?: number;
  DateCreated?: string;
  ImageTags?: Record<string, string>;
  SeriesId?: string;
  SeriesPrimaryImageTag?: string;
  ServerId?: string;
};

export const jellyfin: ConnectorDef = {
  type: 'jellyfin',
  label: 'Jellyfin',
  description: 'Server multimediale: librerie, ultimi contenuti, scansioni, sessioni attive.',
  defaultUrl: 'http://127.0.0.1:8096',
  defaultWebUrl: 'http://192.168.222.200:8096',
  defaultName: 'Jellyfin',
  defaultContainer: 'jellyfin',
  auth: [
    {
      id: 'apikey',
      label: 'API key',
      fields: [{ key: 'apiKey', label: 'API key', type: 'password', required: true, help: 'Dashboard Jellyfin → Chiavi API → +' }],
    },
  ],
  capabilities: ['health', 'system-info', 'libraries', 'latest-items', 'scan-status', 'sessions', 'search'],

  async test(ctx) {
    const pub = json<{ Version: string; ServerName: string; StartupWizardCompleted: boolean }>(
      expectOk(await ctx.http('/System/Info/Public', { headers: { Accept: 'application/json' } }), 'Info pubblica'),
    );
    if (!ctx.secret.apiKey) return { status: 'unconfigured', message: `Raggiungibile (${pub.ServerName}), API key mancante`, version: pub.Version };
    const r = await ctx.http('/System/Info', { headers: headers(ctx) });
    if (r.status === 401 || r.status === 403) return { status: 'unauthorized', message: 'API key rifiutata', version: pub.Version };
    expectOk(r, 'System/Info');
    const info = json<{ HasPendingRestart: boolean; HasUpdateAvailable: boolean; OperatingSystemDisplayName?: string }>(r);
    return {
      status: info.HasPendingRestart ? 'unhealthy' : 'online',
      message: info.HasPendingRestart ? 'Riavvio in sospeso' : `${pub.ServerName} operativo`,
      version: pub.Version,
      details: { serverName: pub.ServerName, updateAvailable: info.HasUpdateAvailable },
    };
  },

  resources: {
    /** Ricerca titoli per Ctrl+K (sola lettura): film, serie ed episodi. */
    async search(ctx, params) {
      const q = (params.get('q') ?? '').trim().slice(0, 80);
      if (q.length < 2) return [];
      const r = await get<{ Items: Item[] }>(
        ctx,
        `/Items?searchTerm=${encodeURIComponent(q)}&Recursive=true&IncludeItemTypes=Movie,Series,Episode&Limit=8&Fields=ProductionYear`,
        'Ricerca',
      );
      return r.Items.map((i) => ({
        id: i.Id,
        name: i.Name,
        type: i.Type,
        year: i.ProductionYear ?? null,
        seriesName: i.SeriesName ?? null,
        season: i.ParentIndexNumber ?? null,
        episode: i.IndexNumber ?? null,
        serverId: i.ServerId ?? null,
      }));
    },
    async overview(ctx) {
      const [info, folders, tasks, sessions, counts] = await Promise.all([
        get<{ ServerName: string; Version: string; HasPendingRestart: boolean; HasUpdateAvailable: boolean }>(ctx, '/System/Info', 'System/Info'),
        get<{ Name: string; CollectionType?: string; Locations: string[]; ItemId: string; RefreshStatus?: string; RefreshProgress?: number }[]>(
          ctx,
          '/Library/VirtualFolders',
          'Librerie',
        ),
        get<{ Name: string; Key: string; State: string; CurrentProgressPercentage?: number; LastExecutionResult?: { EndTimeUtc: string; Status: string } }[]>(
          ctx,
          '/ScheduledTasks?isHidden=false',
          'Task',
        ),
        get<{ NowPlayingItem?: unknown; UserName?: string; Client?: string }[]>(ctx, '/Sessions?activeWithinSeconds=300', 'Sessioni'),
        get<{ MovieCount: number; SeriesCount: number; EpisodeCount: number }>(ctx, '/Items/Counts', 'Conteggi'),
      ]);
      const scan = tasks.find((t) => t.Key === 'RefreshLibrary');
      return {
        serverName: info.ServerName,
        version: info.Version,
        pendingRestart: info.HasPendingRestart,
        updateAvailable: info.HasUpdateAvailable,
        counts: { movies: counts.MovieCount, series: counts.SeriesCount, episodes: counts.EpisodeCount },
        libraries: folders.map((f) => ({
          id: f.ItemId,
          name: f.Name,
          type: f.CollectionType ?? 'mixed',
          locations: f.Locations,
          refreshStatus: f.RefreshStatus ?? null,
          refreshProgress: f.RefreshProgress ?? null,
        })),
        scan: scan
          ? {
              state: scan.State,
              progress: scan.CurrentProgressPercentage ?? null,
              lastEnd: scan.LastExecutionResult?.EndTimeUtc ?? null,
              lastResult: scan.LastExecutionResult?.Status ?? null,
            }
          : null,
        sessions: {
          active: sessions.length,
          playing: sessions.filter((s) => s.NowPlayingItem).length,
        },
      };
    },

    async latest(ctx, params) {
      const limit = Math.min(Number(params.get('limit') ?? 12) || 12, 50);
      const r = await get<{ Items: Item[] }>(
        ctx,
        `/Items?Recursive=true&SortBy=DateCreated&SortOrder=Descending&IncludeItemTypes=Movie,Episode&Limit=${limit}&Fields=DateCreated&EnableImageTypes=Primary`,
        'Ultimi contenuti',
      );
      return r.Items.map((i) => ({
        id: i.Id,
        name: i.Name,
        type: i.Type,
        series: i.SeriesName ?? null,
        season: i.ParentIndexNumber ?? null,
        episode: i.IndexNumber ?? null,
        year: i.ProductionYear ?? null,
        added: i.DateCreated ?? null,
        imageItemId: i.Type === 'Episode' && i.SeriesId && i.SeriesPrimaryImageTag ? i.SeriesId : i.ImageTags?.Primary ? i.Id : null,
      }));
    },
  },
};

/** Proxy immagini poster: evita di esporre l'API key al browser. */
export async function jellyfinImage(ctx: ConnectorContext, itemId: string) {
  if (!/^[0-9a-f]{32}$/i.test(itemId)) throw new ConnectorError('id non valido', 'error', 400);
  const r = await ctx.http(`/Items/${itemId}/Images/Primary?fillHeight=360&quality=85`, {
    headers: headers(ctx),
    maxBytes: 3 * 1024 * 1024,
  });
  expectOk(r, 'Immagine');
  return { type: r.headers.get('content-type') ?? 'image/jpeg', body: r.body };
}
