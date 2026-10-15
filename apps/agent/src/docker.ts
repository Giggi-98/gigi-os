// Accesso Docker Engine tramite dockerode. Solo operazioni nominate: nessun passthrough dell'API.
import Docker from 'dockerode';
import { PassThrough, type Readable } from 'node:stream';
import { redactArgs, redactEnv, redactLine, redactValue } from './redact.js';

export const docker = new Docker({ socketPath: process.env.DOCKER_SOCKET ?? '/var/run/docker.sock' });

const PROTECTED = new Set(
  (process.env.GIGI_PROTECTED_CONTAINERS ?? 'gigi-agent,gigi-api,gigi-media,gigi-files').split(',').map((s) => s.trim()).filter(Boolean),
);
const ALLOW = (process.env.GIGI_CONTROL_ALLOW ?? '*').split(',').map((s) => s.trim()).filter(Boolean);
const STATS_INTERVAL = Number(process.env.GIGI_STATS_MS ?? 15000);

export type ContainerStat = { cpu: number; memUsed: number; memLimit: number; rx: number; tx: number; t: number };
const stats = new Map<string, ContainerStat>();
const inspectCache = new Map<string, { t: number; data: Docker.ContainerInspectInfo }>();

const name = (n: string[] | string) => (Array.isArray(n) ? n[0] : n).replace(/^\//, '');

export function canControl(containerName: string) {
  if (PROTECTED.has(containerName)) return false;
  return ALLOW.includes('*') || ALLOW.includes(containerName);
}

async function inspectCached(id: string) {
  const c = inspectCache.get(id);
  if (c && Date.now() - c.t < 10000) return c.data;
  const data = await docker.getContainer(id).inspect();
  inspectCache.set(id, { t: Date.now(), data });
  return data;
}

export async function listContainers() {
  const list = await docker.listContainers({ all: true });
  return Promise.all(
    list.map(async (c) => {
      const n = name(c.Names);
      let info: Docker.ContainerInspectInfo | null = null;
      try {
        info = await inspectCached(c.Id);
      } catch {}
      const s = stats.get(c.Id);
      return {
        id: c.Id,
        shortId: c.Id.slice(0, 12),
        name: n,
        image: c.Image,
        state: c.State,
        status: c.Status,
        health: info?.State.Health?.Status ?? null,
        created: c.Created * 1000,
        startedAt: info?.State.StartedAt ?? null,
        finishedAt: info?.State.FinishedAt ?? null,
        exitCode: info?.State.ExitCode ?? null,
        restartCount: info?.RestartCount ?? 0,
        restartPolicy: info?.HostConfig.RestartPolicy?.Name ?? null,
        networkMode: c.HostConfig?.NetworkMode ?? null,
        composeProject: c.Labels?.['com.docker.compose.project'] ?? null,
        composeService: c.Labels?.['com.docker.compose.service'] ?? null,
        ports: (c.Ports ?? []).map((p) => ({ ip: p.IP ?? null, private: p.PrivatePort, public: p.PublicPort ?? null, type: p.Type })),
        stats: s ?? null,
        controllable: canControl(n),
      };
    }),
  );
}

export async function inspectContainer(id: string) {
  const i = await docker.getContainer(id).inspect();
  const n = name(i.Name);
  return {
    id: i.Id,
    name: n,
    image: i.Config.Image,
    imageId: i.Image,
    created: i.Created,
    state: {
      status: i.State.Status,
      running: i.State.Running,
      startedAt: i.State.StartedAt,
      finishedAt: i.State.FinishedAt,
      exitCode: i.State.ExitCode,
      oomKilled: i.State.OOMKilled,
      error: i.State.Error || null,
      health: i.State.Health
        ? {
            status: i.State.Health.Status,
            failingStreak: i.State.Health.FailingStreak,
            log: (i.State.Health.Log ?? []).slice(-3).map((l) => ({
              start: l.Start,
              exitCode: l.ExitCode,
              output: redactLine(String(l.Output ?? '').slice(0, 500)),
            })),
          }
        : null,
    },
    restartCount: i.RestartCount,
    restartPolicy: i.HostConfig.RestartPolicy,
    privileged: i.HostConfig.Privileged,
    user: i.Config.User || null,
    networkMode: i.HostConfig.NetworkMode,
    cmd: redactArgs(i.Config.Cmd),
    entrypoint: redactArgs(Array.isArray(i.Config.Entrypoint) ? i.Config.Entrypoint : i.Config.Entrypoint ? [i.Config.Entrypoint] : []),
    env: redactEnv(i.Config.Env),
    labels: Object.entries(i.Config.Labels ?? {}).map(([k, v]) => ({ key: k, value: redactValue(k, v) })),
    mounts: (i.Mounts ?? []).map((m) => ({ type: m.Type, source: m.Source, destination: m.Destination, rw: m.RW, name: m.Name ?? null })),
    ports: Object.entries(i.NetworkSettings.Ports ?? {}).map(([k, v]) => ({
      container: k,
      host: (v ?? []).map((b) => `${b.HostIp || '0.0.0.0'}:${b.HostPort}`),
    })),
    networks: Object.entries(i.NetworkSettings.Networks ?? {}).map(([k, v]) => ({ name: k, ip: v.IPAddress || null })),
    devices: (i.HostConfig.Devices ?? []).map((d: { PathOnHost: string }) => d.PathOnHost),
    capAdd: i.HostConfig.CapAdd ?? [],
    healthcheck: i.Config.Healthcheck
      ? { test: redactArgs(i.Config.Healthcheck.Test), interval: i.Config.Healthcheck.Interval ?? null }
      : null,
    stats: stats.get(i.Id) ?? null,
    controllable: canControl(n),
  };
}

function computeStats(s: Docker.ContainerStats): ContainerStat {
  const cpuDelta = s.cpu_stats.cpu_usage.total_usage - (s.precpu_stats.cpu_usage?.total_usage ?? 0);
  const sysDelta = (s.cpu_stats.system_cpu_usage ?? 0) - (s.precpu_stats.system_cpu_usage ?? 0);
  const online = s.cpu_stats.online_cpus ?? s.cpu_stats.cpu_usage.percpu_usage?.length ?? 1;
  const cpu = sysDelta > 0 && cpuDelta >= 0 ? (cpuDelta / sysDelta) * online * 100 : 0;
  const ms = s.memory_stats as { usage?: number; limit?: number; stats?: Record<string, number> };
  const inactive = ms.stats?.inactive_file ?? ms.stats?.total_inactive_file ?? 0;
  const memUsed = Math.max(0, (ms.usage ?? 0) - inactive);
  let rx = 0;
  let tx = 0;
  for (const n of Object.values(s.networks ?? {})) {
    rx += n.rx_bytes;
    tx += n.tx_bytes;
  }
  return { cpu: Math.round(cpu * 10) / 10, memUsed, memLimit: ms.limit ?? 0, rx, tx, t: Date.now() };
}

async function refreshStats() {
  const list = await docker.listContainers({ all: false });
  const alive = new Set(list.map((c) => c.Id));
  for (const id of stats.keys()) if (!alive.has(id)) stats.delete(id);
  await Promise.all(
    list.map(async (c) => {
      try {
        const s = (await docker.getContainer(c.Id).stats({ stream: false })) as unknown as Docker.ContainerStats;
        stats.set(c.Id, computeStats(s));
      } catch {}
    }),
  );
}

export function startStatsLoop() {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await refreshStats();
    } catch (e) {
      console.error(JSON.stringify({ level: 'error', msg: 'stats failed', err: String(e) }));
    } finally {
      running = false;
    }
  };
  void tick();
  setInterval(tick, STATS_INTERVAL).unref();
}

/** Restituisce uno stream NDJSON di righe di log già oscurate. */
export async function logStream(id: string, opts: { tail: number; follow: boolean; since?: number }): Promise<Readable> {
  const c = docker.getContainer(id);
  const info = await inspectCached(id);
  const out = new PassThrough();
  const params = { stdout: true, stderr: true, timestamps: true, tail: opts.tail, since: opts.since ?? 0 };
  const raw = (opts.follow
    ? await c.logs({ ...params, follow: true })
    : await c.logs({ ...params, follow: false })) as unknown as Readable | Buffer;

  const emitter = (stream: 'stdout' | 'stderr') => {
    let buf = '';
    const pt = new PassThrough();
    pt.on('data', (chunk: Buffer) => {
      buf += chunk.toString('utf8');
      let i: number;
      while ((i = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        const sp = line.indexOf(' ');
        const ts = sp > 0 ? line.slice(0, sp) : '';
        const text = sp > 0 ? line.slice(sp + 1) : line;
        out.write(JSON.stringify({ ts, stream, line: redactLine(text.slice(0, 8000)) }) + '\n');
      }
    });
    return pt;
  };

  if (Buffer.isBuffer(raw)) {
    const so = emitter('stdout');
    const se = emitter('stderr');
    if (info.Config.Tty) so.write(raw);
    else demuxBuffer(raw, so, se);
    so.end('\n');
    se.end('\n');
    setImmediate(() => out.end());
  } else {
    const so = emitter('stdout');
    const se = emitter('stderr');
    if (info.Config.Tty) raw.pipe(so);
    else docker.modem.demuxStream(raw, so, se);
    raw.on('end', () => out.end());
    raw.on('error', () => out.end());
    out.on('close', () => (raw as Readable & { destroy: () => void }).destroy());
  }
  return out;
}

function demuxBuffer(buf: Buffer, so: PassThrough, se: PassThrough) {
  let off = 0;
  while (off + 8 <= buf.length) {
    const type = buf[off];
    const len = buf.readUInt32BE(off + 4);
    const payload = buf.subarray(off + 8, off + 8 + len);
    (type === 2 ? se : so).write(payload);
    off += 8 + len;
  }
}

export async function containerAction(id: string, action: 'start' | 'stop' | 'restart') {
  const c = docker.getContainer(id);
  const info = await c.inspect();
  const n = name(info.Name);
  if (!canControl(n)) throw Object.assign(new Error(`Il container ${n} non è controllabile da GIGI OS`), { status: 403 });
  if (action === 'start') await c.start();
  else if (action === 'stop') await c.stop({ t: 20 });
  else await c.restart({ t: 20 });
  inspectCache.delete(info.Id);
  return { id: info.Id, name: n, action };
}

export async function listImages() {
  const [images, containers] = await Promise.all([docker.listImages({ all: false }), docker.listContainers({ all: true })]);
  return images.map((i) => {
    const users = containers.filter((c) => c.ImageID === i.Id).map((c) => name(c.Names));
    return {
      id: i.Id,
      tags: i.RepoTags?.filter((t) => t !== '<none>:<none>') ?? [],
      size: i.Size,
      created: i.Created * 1000,
      containers: users,
      dangling: !i.RepoTags || i.RepoTags.every((t) => t === '<none>:<none>'),
    };
  });
}

export async function listVolumes() {
  const [vols, containers] = await Promise.all([docker.listVolumes(), docker.listContainers({ all: true })]);
  return (vols.Volumes ?? []).map((v) => ({
    name: v.Name,
    driver: v.Driver,
    mountpoint: v.Mountpoint,
    project: v.Labels?.['com.docker.compose.project'] ?? null,
    containers: containers.filter((c) => c.Mounts?.some((m) => m.Name === v.Name)).map((c) => name(c.Names)),
  }));
}

export async function listNetworks() {
  const [nets, containers] = await Promise.all([docker.listNetworks(), docker.listContainers({ all: true })]);
  return nets.map((n) => ({
    id: n.Id,
    name: n.Name,
    driver: n.Driver,
    scope: n.Scope,
    subnet: n.IPAM?.Config?.[0]?.Subnet ?? null,
    containers: containers
      .filter((c) => Object.keys(c.NetworkSettings?.Networks ?? {}).includes(n.Name) || c.HostConfig?.NetworkMode === n.Name)
      .map((c) => name(c.Names)),
  }));
}

export async function engineInfo() {
  const [v, i] = await Promise.all([docker.version(), docker.info()]);
  return {
    version: v.Version,
    apiVersion: v.ApiVersion,
    containers: i.Containers,
    running: i.ContainersRunning,
    stopped: i.ContainersStopped,
    images: i.Images,
    storageDriver: i.Driver,
    loggingDriver: i.LoggingDriver,
    dockerRootDir: i.DockerRootDir,
  };
}

/** Eventi Docker per invalidare cache e notificare l'API (riavvii, morti, health). */
export async function eventStream(): Promise<Readable> {
  return (await docker.getEvents({ filters: { type: ['container'] } })) as unknown as Readable;
}
