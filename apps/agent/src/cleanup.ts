// Operazioni distruttive su risorse Docker (D-024). Una risorsa alla volta, mai `force`:
// se Docker la considera in uso, l'operazione fallisce invece di forzare.
import { docker, canControl } from './docker.js';

const name = (n: string[] | string) => (Array.isArray(n) ? n[0] : n).replace(/^\//, '');
const BUILTIN_NETWORKS = new Set(['bridge', 'host', 'none']);
// Volumi e reti dello stack GIGI OS: rimuoverli romperebbe i socket tra i processi.
const OWN_PREFIX = 'gigi-os_';

const conflict = (msg: string) => Object.assign(new Error(msg), { status: 409 });
const forbidden = (msg: string) => Object.assign(new Error(msg), { status: 403 });

/** Spazio occupato e recuperabile (docker system df). Può richiedere qualche secondo. */
export async function diskUsage() {
  const df = (await docker.df()) as {
    LayersSize?: number;
    Images?: { Id: string; Size: number; SharedSize: number; Containers: number }[];
    Containers?: { SizeRw?: number; State: string }[];
    Volumes?: { Name: string; UsageData?: { Size: number; RefCount: number } }[];
    BuildCache?: { Size: number; InUse: boolean; Shared: boolean }[];
  };
  const images = df.Images ?? [];
  const volumes = df.Volumes ?? [];
  const cache = df.BuildCache ?? [];
  const containers = df.Containers ?? [];
  return {
    images: {
      count: images.length,
      size: df.LayersSize ?? 0,
      reclaimable: images.filter((i) => i.Containers === 0).reduce((a, i) => a + i.Size - Math.max(0, i.SharedSize), 0),
      unused: images.filter((i) => i.Containers === 0).length,
    },
    volumes: {
      count: volumes.length,
      size: volumes.reduce((a, v) => a + Math.max(0, v.UsageData?.Size ?? 0), 0),
      reclaimable: volumes.filter((v) => v.UsageData?.RefCount === 0).reduce((a, v) => a + Math.max(0, v.UsageData?.Size ?? 0), 0),
      unused: volumes.filter((v) => v.UsageData?.RefCount === 0).length,
      sizes: Object.fromEntries(volumes.map((v) => [v.Name, v.UsageData?.Size ?? -1])),
    },
    buildCache: {
      count: cache.length,
      size: cache.reduce((a, c) => a + c.Size, 0),
      reclaimable: cache.filter((c) => !c.InUse && !c.Shared).reduce((a, c) => a + c.Size, 0),
    },
    containers: {
      stopped: containers.filter((c) => c.State !== 'running').length,
      size: containers.reduce((a, c) => a + (c.SizeRw ?? 0), 0),
    },
  };
}

/**
 * Rimuove un'immagine con TUTTI i suoi tag. Accetta solo l'ID completo: un tag verrebbe risolto
 * nell'immagine sottostante e cancellerebbe anche gli altri tag (verificato il 2026-10-16).
 */
export async function removeImage(id: string) {
  if (!/^sha256:[0-9a-f]{64}$/.test(id)) throw Object.assign(new Error('Serve l’ID completo dell’immagine (sha256:…)'), { status: 400 });
  const info = await docker.getImage(id).inspect();
  const all = await docker.listContainers({ all: true });
  const users = all.filter((c) => c.ImageID === info.Id).map((c) => name(c.Names));
  if (users.length) throw conflict(`Immagine usata da ${users.join(', ')}: rimuovi prima il container`);
  const tags = (info.RepoTags ?? []).filter((t) => t !== '<none>:<none>');
  // Un'immagine con più tag va rimossa tag per tag: l'ultimo elimina anche i layer. Niente force.
  if (tags.length > 1) for (const t of tags.slice(0, -1)) await docker.getImage(t).remove({ noprune: false });
  const removed = await docker.getImage(tags.at(-1) ?? info.Id).remove({ noprune: false });
  return { id: info.Id, tags, removed: Array.isArray(removed) ? removed.length : 0, size: info.Size };
}

export async function removeVolume(volName: string) {
  if (volName.startsWith(OWN_PREFIX)) throw forbidden('Volume dello stack GIGI OS: non rimovibile da qui');
  const all = await docker.listContainers({ all: true });
  const users = all.filter((c) => c.Mounts?.some((m) => m.Name === volName)).map((c) => name(c.Names));
  if (users.length) throw conflict(`Volume usato da ${users.join(', ')} (anche se fermo): rimuovi prima il container`);
  await docker.getVolume(volName).remove();
  return { name: volName };
}

export async function removeNetwork(id: string) {
  const net = docker.getNetwork(id);
  const info = (await net.inspect()) as { Id: string; Name: string; Containers?: Record<string, unknown> };
  if (BUILTIN_NETWORKS.has(info.Name)) throw forbidden(`La rete ${info.Name} è predefinita di Docker`);
  if (info.Name.startsWith(OWN_PREFIX)) throw forbidden('Rete dello stack GIGI OS: non rimovibile da qui');
  const all = await docker.listContainers({ all: true });
  const users = all.filter((c) => Object.keys(c.NetworkSettings?.Networks ?? {}).includes(info.Name)).map((c) => name(c.Names));
  if (users.length || Object.keys(info.Containers ?? {}).length) throw conflict(`Rete usata da ${users.join(', ') || 'container attivi'}`);
  await net.remove();
  return { id: info.Id, name: info.Name };
}

/** Rimuove un container fermo e non protetto. I volumi anonimi restano (si eliminano a parte). */
export async function removeContainer(id: string) {
  const c = docker.getContainer(id);
  const info = await c.inspect();
  const n = name(info.Name);
  if (!canControl(n)) throw forbidden(`Il container ${n} è protetto`);
  if (info.State.Running || info.State.Restarting) throw conflict(`${n} è in esecuzione: fermalo prima di rimuoverlo`);
  await c.remove({ v: false, force: false });
  return { id: info.Id, name: n };
}

export async function pruneBuildCache() {
  const r = (await docker.pruneBuilder()) as { SpaceReclaimed?: number; CachesDeleted?: string[] | null };
  return { reclaimed: r.SpaceReclaimed ?? 0, deleted: r.CachesDeleted?.length ?? 0 };
}
