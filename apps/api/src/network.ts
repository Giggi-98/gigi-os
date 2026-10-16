// Rete (D-026): schede, rotte, DNS, porte in ascolto, connessioni, firewall, test e strumenti.
// Tutto in sola lettura e senza privilegi: gigi-api è in rete host, quindi /proc/net e /sys/class/net
// sono quelli dell'host. Le regole UFW si leggono solo da un'istantanea scritta da un timer di root
// facoltativo (scripts/host); i blocchi del firewall arrivano dal journal tramite l'agent.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import dgram from 'node:dgram';
import dns from 'node:dns/promises';
import { readFile, readdir, readlink, stat } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AgentClient } from './agent.js';
import { getSetting, setSetting, type DB } from './db.js';
import type { Events } from './events.js';
import type { Audit } from './security.js';

const SYS = process.env.GIGI_SYS ?? '/sys';
const PROC = process.env.GIGI_PROC ?? '/proc';
const RESOLV = process.env.GIGI_RESOLV_FILE ?? '/host/resolve/resolv.conf';

const fail = (status: number, msg: string) => Object.assign(new Error(msg), { statusCode: status });
const HOST_RE = /^(?!-)[a-zA-Z0-9.:-]{1,253}$/;
const MAC_RE = /^([0-9a-f]{2}[:-]){5}[0-9a-f]{2}$/i;

// Porte note sull'host (attribuzione "probabile": senza root non si legge il processo proprietario)
const KNOWN: Record<number, string> = {
  22: 'SSH',
  53: 'DNS (systemd-resolved)',
  67: 'DHCP',
  68: 'DHCP client',
  80: 'HTTP',
  111: 'rpcbind',
  123: 'NTP',
  139: 'Samba',
  443: 'HTTPS',
  445: 'Samba',
  631: 'CUPS (stampa)',
  1900: 'SSDP/DLNA',
  2019: 'Caddy (API di amministrazione)',
  3306: 'MySQL',
  3307: 'MySQL (porta alternativa)',
  3389: 'Desktop remoto (RDP)',
  4173: 'Apollo',
  4416: 'POT provider (Armony)',
  4533: 'Navidrome',
  5060: 'SIP',
  5353: 'mDNS (Avahi)',
  5355: 'LLMNR',
  5900: 'VNC',
  6881: 'BitTorrent (qBittorrent)',
  7359: 'Jellyfin (scoperta client)',
  8080: 'HTTP alternativo',
  8085: 'qBittorrent WebUI',
  8096: 'Jellyfin',
  8123: 'Home Assistant',
  8470: 'GIGI OS',
  8920: 'Jellyfin HTTPS',
  18554: 'go2rtc RTSP (Home Assistant)',
  18555: 'go2rtc WebRTC (Home Assistant)',
  41641: 'Tailscale',
  51820: 'WireGuard',
};

// ───────────── /proc e /sys ─────────────

async function sysRead(name: string, f: string) {
  try {
    return (await readFile(path.join(SYS, 'class/net', name, f), 'utf8')).trim();
  } catch {
    return null;
  }
}
async function exists(p: string) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}
const num = (s: string | null) => (s === null || s === '' || Number.isNaN(Number(s)) ? null : Number(s));

function hexToIp4(hex: string) {
  const n = parseInt(hex, 16);
  return [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255].join('.');
}
function hexToIp6(hex: string) {
  // 4 parole a 32 bit, ciascuna in little-endian
  const words = hex.match(/.{8}/g) ?? [];
  const bytes = words.flatMap((w) => (w.match(/../g) ?? []).reverse());
  const groups = [];
  for (let i = 0; i < 16; i += 2) groups.push(`${bytes[i]}${bytes[i + 1]}`.replace(/^0{1,3}/, ''));
  const full = groups.join(':');
  const v4mapped = /^0:0:0:0:0:ffff:([0-9a-f]+):([0-9a-f]+)$/.exec(full);
  if (v4mapped) {
    const a = parseInt(v4mapped[1], 16);
    const b = parseInt(v4mapped[2], 16);
    return `::ffff:${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`;
  }
  return full.replace(/(^|:)0(:0)+(:|$)/, '::').replace(/:{3,}/, '::');
}
const hexAddr = (h: string) => (h.length === 8 ? hexToIp4(h) : hexToIp6(h));

type Sock = { proto: 'tcp' | 'udp'; v6: boolean; local: string; port: number; remote: string; rport: number; state: string };
async function readSockets(): Promise<Sock[]> {
  const out: Sock[] = [];
  for (const [file, proto, v6] of [
    ['tcp', 'tcp', false],
    ['tcp6', 'tcp', true],
    ['udp', 'udp', false],
    ['udp6', 'udp', true],
  ] as const) {
    let text = '';
    try {
      text = await readFile(path.join(PROC, 'net', file), 'utf8');
    } catch {
      continue;
    }
    for (const l of text.split('\n').slice(1)) {
      const c = l.trim().split(/\s+/);
      if (c.length < 4) continue;
      const [la, lp] = c[1].split(':');
      const [ra, rp] = c[2].split(':');
      out.push({ proto, v6, local: hexAddr(la), port: parseInt(lp, 16), remote: hexAddr(ra), rport: parseInt(rp, 16), state: c[3] });
    }
  }
  return out;
}

const isLoopback = (a: string) => a.startsWith('127.') || a === '::1' || a.startsWith('::ffff:127.');
const isAny = (a: string) => a === '0.0.0.0' || a === '::';
const isPrivate = (a: string) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|fe80:|fd|fc|::ffff:(10|192\.168)\.)/i.test(a) || isLoopback(a);

// ───────────── UFW (istantanea) ─────────────

export type UfwRule = { to: string; port: number | null; proto: string | null; action: string; from: string; v6: boolean; comment: string | null };
export function parseUfwStatus(text: string) {
  const status = /^Status:\s*(\w+)/m.exec(text)?.[1] ?? null;
  const logging = /^Logging:\s*(.+)$/m.exec(text)?.[1]?.trim() ?? null;
  const defaults = /^Default:\s*(.+)$/m.exec(text)?.[1]?.trim() ?? null;
  const rules: UfwRule[] = [];
  const lines = text.split('\n');
  const start = lines.findIndex((l) => /^--\s+/.test(l.trim()));
  for (const raw of start >= 0 ? lines.slice(start + 1) : []) {
    if (!raw.trim()) continue;
    const [main, ...c] = raw.split('#');
    const cols = main.trim().split(/\s{2,}/);
    if (cols.length < 3) continue;
    const to = cols[0].replace(/^\[\s*\d+\]\s*/, '');
    const v6 = /\(v6\)/.test(raw);
    const m = /^(\d+)(?::\d+)?(?:\/(tcp|udp))?/.exec(to);
    rules.push({
      to: to.replace(/\s*\(v6\)/, ''),
      port: m ? Number(m[1]) : null,
      proto: m?.[2] ?? null,
      action: cols[1],
      from: cols[2].replace(/\s*\(v6\)/, ''),
      v6,
      comment: c.join('#').trim() || null,
    });
  }
  return { status, logging, defaults, rules };
}

// ───────────── Comandi (ping, tracepath) ─────────────

function run(cmd: string, args: string[], timeoutMs: number) {
  return new Promise<{ code: number; out: string }>((resolve) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH ?? '/usr/bin:/bin', LC_ALL: 'C' } });
    let out = '';
    const add = (c: Buffer) => {
      if (out.length < 64 * 1024) out += c.toString('utf8');
    };
    child.stdout.on('data', add);
    child.stderr.on('data', add);
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: 127, out: `comando non disponibile: ${(e as NodeJS.ErrnoException).code ?? e.message}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, out });
    });
  });
}

export function parsePing(out: string) {
  const sent = /(\d+) packets transmitted/.exec(out);
  const recv = /(\d+) (?:packets )?received/.exec(out);
  const rtt = /= ([\d.]+)\/([\d.]+)\/([\d.]+)(?:\/([\d.]+))? ms/.exec(out);
  const replies = [...out.matchAll(/time=([\d.]+) ms/g)].map((m) => Number(m[1]));
  return {
    sent: sent ? Number(sent[1]) : 0,
    received: recv ? Number(recv[1]) : 0,
    min: rtt ? Number(rtt[1]) : null,
    avg: rtt ? Number(rtt[2]) : null,
    max: rtt ? Number(rtt[3]) : null,
    jitter: rtt?.[4] ? Number(rtt[4]) : null,
    replies,
  };
}

async function ping(host: string, count = 4) {
  const r = await run('ping', ['-n', '-c', String(count), '-i', '0.3', '-W', '2', host], 8000 + count * 2500);
  return { ...parsePing(r.out), ok: r.code === 0, output: r.out.trim().split('\n').slice(-12).join('\n') };
}

// ───────────── Speed test (Cloudflare) ─────────────

type Speed = {
  id: string;
  status: 'running' | 'ok' | 'error';
  phase: 'latency' | 'download' | 'upload' | 'done';
  startedAt: number;
  endedAt: number | null;
  latency: number | null;
  jitter: number | null;
  download: number | null;
  upload: number | null;
  live: number | null;
  error: string | null;
};
const CF = 'https://speed.cloudflare.com';

// ───────────── Classe principale ─────────────

type Monitor = { publicIp: boolean; devices: boolean };
type Known = Record<string, { ip: string; firstSeen: number; lastSeen: number; name: string | null }>;

export class Network {
  private prev = new Map<string, { t: number; rx: number; tx: number }>();
  private publicCache: { t: number; data: unknown } | null = null;
  private speed: Speed | null = null;
  private scanning = false;

  constructor(private db: DB, private dataDir: string, private agent: AgentClient, private events: Events) {}

  blocked(hours: number) {
    return this.agent.json('GET', `/v1/firewall/blocked?hours=${hours}`, 30_000);
  }

  // ── Schede, rotte, DNS ──
  async overview() {
    const names = await readdir(path.join(SYS, 'class/net')).catch(() => [] as string[]);
    const addrs = os.networkInterfaces();
    const now = Date.now();
    let dockerNets: { id: string; name: string }[] = [];
    try {
      dockerNets = await this.agent.json('GET', '/v1/networks');
    } catch {}
    const wireless = await this.wireless();
    const interfaces = await Promise.all(
      names.map(async (name) => {
        const base = path.join(SYS, 'class/net', name);
        const kind =
          name === 'lo'
            ? 'loopback'
            : (await exists(path.join(base, 'wireless'))) || (await exists(path.join(base, 'phy80211')))
              ? 'wifi'
              : (await exists(path.join(base, 'bridge')))
                ? 'bridge'
                : name.startsWith('veth')
                  ? 'veth'
                  : (await exists(path.join(base, 'device')))
                    ? 'ethernet'
                    : 'virtual';
        const stat = async (f: string) => num(await sysRead(name, `statistics/${f}`)) ?? 0;
        const [operstate, carrier, mac, mtu, speed, duplex, rx, tx, rxPackets, txPackets, rxErrors, txErrors, rxDropped, txDropped] = await Promise.all([
          sysRead(name, 'operstate'),
          sysRead(name, 'carrier'),
          sysRead(name, 'address'),
          sysRead(name, 'mtu'),
          sysRead(name, 'speed'),
          sysRead(name, 'duplex'),
          stat('rx_bytes'),
          stat('tx_bytes'),
          stat('rx_packets'),
          stat('tx_packets'),
          stat('rx_errors'),
          stat('tx_errors'),
          stat('rx_dropped'),
          stat('tx_dropped'),
        ]);
        let driver: string | null = null;
        try {
          driver = path.basename(await readlink(path.join(base, 'device/driver')));
        } catch {}
        const p = this.prev.get(name);
        const dt = p ? (now - p.t) / 1000 : 0;
        this.prev.set(name, { t: now, rx, tx });
        const docker =
          name === 'docker0' ? 'bridge' : name.startsWith('br-') ? dockerNets.find((n) => n.id.startsWith(name.slice(3)))?.name ?? null : null;
        const sp = num(speed);
        return {
          name,
          kind,
          state: operstate,
          carrier: carrier === '1',
          mac: kind === 'loopback' ? null : mac,
          mtu: num(mtu),
          speed: sp !== null && sp > 0 ? sp : null,
          duplex: duplex && duplex !== 'unknown' ? duplex : null,
          driver,
          docker,
          wifi: wireless[name] ?? null,
          addresses: (addrs[name] ?? []).map((a) => ({ family: a.family, address: a.address, cidr: a.cidr, scope: a.family === 'IPv6' && a.address.startsWith('fe80') ? 'link' : 'global' })),
          rx,
          tx,
          rxRate: p && dt > 0.5 ? Math.max(0, (rx - p.rx) / dt) : null,
          txRate: p && dt > 0.5 ? Math.max(0, (tx - p.tx) / dt) : null,
          packets: { rx: rxPackets, tx: txPackets },
          errors: rxErrors + txErrors,
          dropped: rxDropped + txDropped,
        };
      }),
    );
    const order = { ethernet: 0, wifi: 1, bridge: 2, virtual: 3, veth: 4, loopback: 5 } as Record<string, number>;
    interfaces.sort((a, b) => order[a.kind] - order[b.kind] || a.name.localeCompare(b.name));
    return {
      hostname: os.hostname(),
      interfaces,
      routes: await this.routes(),
      dns: await this.dns(),
      forwarding: (await readFile(path.join(PROC, 'sys/net/ipv4/ip_forward'), 'utf8').catch(() => '')).trim() === '1',
    };
  }

  private async wireless() {
    const out: Record<string, { quality: number; signal: number }> = {};
    try {
      for (const l of (await readFile(path.join(PROC, 'net/wireless'), 'utf8')).split('\n').slice(2)) {
        const m = /^\s*(\S+):\s+\S+\s+([\d.-]+)\.?\s+([\d.-]+)/.exec(l);
        if (m) out[m[1]] = { quality: Number(m[2]), signal: Number(m[3]) };
      }
    } catch {}
    return out;
  }

  private async routes() {
    const v4: { iface: string; destination: string; gateway: string | null; mask: string; metric: number; isDefault: boolean }[] = [];
    try {
      for (const l of (await readFile(path.join(PROC, 'net/route'), 'utf8')).split('\n').slice(1)) {
        const c = l.trim().split(/\s+/);
        if (c.length < 8) continue;
        const prefix = hexToIp4(c[7]).split('.').reduce((a, o) => a + (Number(o).toString(2).match(/1/g)?.length ?? 0), 0);
        v4.push({ iface: c[0], destination: `${hexToIp4(c[1])}/${prefix}`, gateway: c[2] === '00000000' ? null : hexToIp4(c[2]), mask: hexToIp4(c[7]), metric: Number(c[6]), isDefault: c[1] === '00000000' });
      }
    } catch {}
    const v6: { iface: string; gateway: string }[] = [];
    try {
      for (const l of (await readFile(path.join(PROC, 'net/ipv6_route'), 'utf8')).split('\n')) {
        const c = l.trim().split(/\s+/);
        if (c.length < 10 || c[0] !== '0'.repeat(32) || c[1] !== '00' || c[4] === '0'.repeat(32)) continue;
        v6.push({ iface: c[9], gateway: hexToIp6(c[4]) });
      }
    } catch {}
    return { v4, v6Default: v6 };
  }

  private async dns() {
    try {
      const text = await readFile(RESOLV, 'utf8');
      return {
        servers: [...text.matchAll(/^nameserver\s+(\S+)/gm)].map((m) => m[1]),
        search: /^search\s+(.+)$/m.exec(text)?.[1]?.split(/\s+/).filter((s) => s !== '.') ?? [],
        source: 'systemd-resolved',
      };
    } catch {
      return { servers: [] as string[], search: [] as string[], source: null };
    }
  }

  // ── Servizi in ascolto ──
  async listening() {
    const [socks, containers] = await Promise.all([
      readSockets(),
      this.agent
        .json<{ name: string; networkMode: string | null; ports: { ip: string | null; private: number; public: number | null; type: string }[] }[]>('GET', '/v1/containers')
        .catch(() => []),
    ]);
    const published = new Map<string, { container: string; ip: string | null }>();
    for (const c of containers) for (const p of c.ports) if (p.public) published.set(`${p.type}/${p.public}`, { container: c.name, ip: p.ip });
    const hostNet = containers.filter((c) => c.networkMode === 'host').map((c) => c.name);

    const map = new Map<string, { proto: string; port: number; addresses: Set<string> }>();
    for (const s of socks) {
      const listening = s.proto === 'tcp' ? s.state === '0A' : s.state === '07' && s.rport === 0;
      if (!listening) continue;
      const key = `${s.proto}/${s.port}`;
      const e = map.get(key) ?? { proto: s.proto, port: s.port, addresses: new Set<string>() };
      e.addresses.add(s.local);
      map.set(key, e);
    }
    const snapshot = await this.ufwSnapshot();
    const items = [...map.values()].map((e) => {
      const addresses = [...e.addresses];
      const scope = addresses.some(isAny) ? 'all' : addresses.every(isLoopback) ? 'local' : 'specific';
      const pub = published.get(`${e.proto}/${e.port}`);
      const known = KNOWN[e.port] ?? null;
      const rules = snapshot?.rules.filter((r) => r.port === e.port && (!r.proto || r.proto === e.proto) && /ALLOW/.test(r.action)) ?? null;
      return {
        proto: e.proto,
        port: e.port,
        addresses,
        scope,
        service: pub ? pub.container : known,
        source: pub ? 'docker' : known ? 'nota' : null,
        ephemeral: e.port >= 32768 && !pub && !known,
        // Le porte pubblicate da Docker scrivono regole iptables proprie: UFW non le filtra
        bypassUfw: !!pub && (!pub.ip || isAny(pub.ip)),
        allowedFrom: rules ? [...new Set(rules.map((r) => r.from))] : null,
      };
    });
    items.sort((a, b) => Number(a.ephemeral) - Number(b.ephemeral) || a.port - b.port || a.proto.localeCompare(b.proto));
    return { items, hostNetworkContainers: hostNet, firewallKnown: !!snapshot };
  }

  // ── Connessioni attive ──
  async connections() {
    const socks = (await readSockets()).filter((s) => s.proto === 'tcp');
    const STATES: Record<string, string> = { '01': 'ESTABLISHED', '02': 'SYN_SENT', '03': 'SYN_RECV', '04': 'FIN_WAIT1', '05': 'FIN_WAIT2', '06': 'TIME_WAIT', '07': 'CLOSE', '08': 'CLOSE_WAIT', '09': 'LAST_ACK', '0A': 'LISTEN', '0B': 'CLOSING' };
    const states: Record<string, number> = {};
    for (const s of socks) states[STATES[s.state] ?? s.state] = (states[STATES[s.state] ?? s.state] ?? 0) + 1;
    const listenPorts = new Set(socks.filter((s) => s.state === '0A').map((s) => s.port));
    const own = new Set(Object.values(os.networkInterfaces()).flatMap((l) => (l ?? []).map((a) => a.address)));
    const peers = new Map<string, { remote: string; count: number; inbound: Set<number>; outbound: Set<number>; external: boolean }>();
    for (const s of socks) {
      if (s.state !== '01' || isLoopback(s.remote) || /^(::ffff:)?172\.(1[6-9]|2\d|3[01])\./.test(s.remote)) continue;
      const remote = s.remote.replace(/^::ffff:/, '');
      if (own.has(remote)) continue;
      const p = peers.get(remote) ?? { remote, count: 0, inbound: new Set(), outbound: new Set(), external: !isPrivate(remote) };
      p.count++;
      if (listenPorts.has(s.port)) p.inbound.add(s.port);
      else p.outbound.add(s.rport);
      peers.set(remote, p);
    }
    return {
      states,
      total: socks.length,
      peers: [...peers.values()]
        .sort((a, b) => b.count - a.count)
        .slice(0, 50)
        .map((p) => ({ ...p, inbound: [...p.inbound].map((port) => ({ port, service: KNOWN[port] ?? null })), outbound: [...p.outbound].slice(0, 8) })),
    };
  }

  // ── Firewall ──
  private snapshotFile() {
    return path.join(this.dataDir, 'host', 'ufw-status.txt');
  }
  async ufwSnapshot() {
    try {
      const [text, st] = await Promise.all([readFile(this.snapshotFile(), 'utf8'), stat(this.snapshotFile())]);
      return { ...parseUfwStatus(text), updatedAt: st.mtimeMs };
    } catch {
      return null;
    }
  }

  async firewall() {
    const [snapshot, listening] = await Promise.all([this.ufwSnapshot(), this.listening()]);
    const findings: { level: 'warn' | 'info' | 'ok'; message: string }[] = [];
    for (const l of listening.items.filter((i) => i.bypassUfw))
      findings.push({ level: 'warn', message: `Porta ${l.port}/${l.proto} (${l.service}) pubblicata da Docker su tutte le interfacce: UFW non la filtra. Per la sola LAN pubblicala come 192.168.222.200:${l.port}:…` });
    if (snapshot) {
      if (Date.now() - snapshot.updatedAt > 20 * 60_000) findings.push({ level: 'warn', message: 'L’istantanea delle regole è vecchia di oltre 20 minuti: il timer gigi-ufw-snapshot potrebbe essere fermo' });
      if (snapshot.status !== 'active') findings.push({ level: 'warn', message: 'UFW non è attivo: tutte le porte in ascolto sono raggiungibili' });
      const open = listening.items.filter((i) => !i.ephemeral);
      for (const r of snapshot.rules.filter((x) => /ALLOW/.test(x.action) && /^Anywhere/.test(x.from) && !x.v6 && x.port)) {
        const l = open.find((i) => i.port === r.port && (!r.proto || r.proto === i.proto));
        if (!l) findings.push({ level: 'info', message: `Regola ${r.to} aperta a chiunque, ma nessun servizio è in ascolto: forse obsoleta` });
        else if (l.scope !== 'local') findings.push({ level: 'warn', message: `${r.to}${l.service ? ` (${l.service})` : ''} è aperta a chiunque: raggiungibile da Internet se il router inoltra la porta` });
      }
      const covered = new Set(snapshot.rules.filter((r) => /ALLOW/.test(r.action)).map((r) => r.port));
      const blocked = listening.items.filter((i) => i.scope !== 'local' && !i.ephemeral && !i.bypassUfw && !covered.has(i.port));
      if (blocked.length) findings.push({ level: 'ok', message: `In ascolto ma bloccate da UFW dall’esterno: ${blocked.map((b) => `${b.port}/${b.proto}`).join(', ')}` });
    }
    return { snapshot, findings, snapshotPath: this.snapshotFile() };
  }

  // ── IP pubblico ──
  async publicIp(refresh = false) {
    if (!refresh && this.publicCache && Date.now() - this.publicCache.t < 60_000) return this.publicCache.data as { v4: string | null; v6: string | null };
    const get = async (urls: string[]) => {
      for (const u of urls) {
        try {
          const r = await fetch(u, { signal: AbortSignal.timeout(5000) });
          const t = (await r.text()).trim();
          const ip = t.startsWith('{') ? (JSON.parse(t) as { ip: string }).ip : t;
          if (net.isIP(ip)) return ip;
        } catch {}
      }
      return null;
    };
    const [v4, v6] = await Promise.all([get(['https://api.ipify.org?format=json', 'https://ipv4.icanhazip.com']), get(['https://api6.ipify.org?format=json', 'https://ipv6.icanhazip.com'])]);
    let ptr: string | null = null;
    if (v4) ptr = (await withTimeout(dns.reverse(v4), 3000).catch(() => []))[0] ?? null;
    const data = { v4, v6, ptr, checkedAt: Date.now(), previous: getSetting(this.db, 'net.publicIp') };
    if (v4) {
      const prev = getSetting(this.db, 'net.publicIp');
      if (prev && prev !== v4) this.events.add('warning', 'rete', `IP pubblico cambiato: ${prev} → ${v4}`, null, `publicip:${v4}`);
      setSetting(this.db, 'net.publicIp', v4);
    }
    this.publicCache = { t: Date.now(), data };
    return data;
  }

  // ── Test ──
  async test(t: TestInput) {
    const started = performance.now();
    switch (t.type) {
      case 'ping':
        return { type: t.type, ...(await ping(t.host, t.count ?? 4)) };
      case 'tracepath': {
        const r = await run('tracepath', ['-n', '-m', '20', t.host], 45_000);
        // tracepath ripete un salto per ogni sonda: si tiene l'ultima risposta utile per numero di salto
        const byHop = new Map<number, { hop: number; host: string; time: string | null }>();
        for (const m of r.out.matchAll(/^\s*(\d+)\??:\s+(\S+)\s+([\d.]+ms)?/gm)) {
          if (m[2] === '[LOCALHOST]') continue;
          const prev = byHop.get(Number(m[1]));
          if (!prev || m[2] !== 'no' || !prev.time) byHop.set(Number(m[1]), { hop: Number(m[1]), host: m[2] === 'no' ? 'nessuna risposta' : m[2], time: m[3] ?? prev?.time ?? null });
        }
        const hops = [...byHop.values()];
        const pmtu = /pmtu (\d+)/.exec(r.out)?.[1];
        return { type: t.type, ok: r.code === 0, hops, pmtu: pmtu ? Number(pmtu) : null, output: r.out.trim() };
      }
      case 'dns': {
        const ds = await this.dns();
        const targets = t.server ? [t.server] : [...new Set(['sistema', ...ds.servers.filter((s) => !s.startsWith('127.')), '1.1.1.1', '8.8.8.8', '9.9.9.9'])];
        const results = await Promise.all(
          targets.map(async (server) => {
            const r = new dns.Resolver({ timeout: 4000, tries: 1 });
            if (server !== 'sistema') r.setServers([server]);
            const t0 = performance.now();
            try {
              const rec = await resolve(r, t.name, t.record ?? 'A');
              return { server, ok: true, ms: Math.round(performance.now() - t0), records: rec };
            } catch (e) {
              return { server, ok: false, ms: Math.round(performance.now() - t0), error: (e as NodeJS.ErrnoException).code ?? (e as Error).message };
            }
          }),
        );
        return { type: t.type, name: t.name, record: t.record ?? 'A', results };
      }
      case 'tcp': {
        const t0 = performance.now();
        const r = await new Promise<{ ok: boolean; error?: string; address?: string }>((resolve) => {
          const s = net.connect({ host: t.host, port: t.port, timeout: 5000 });
          s.once('connect', () => {
            const address = s.remoteAddress;
            s.destroy();
            resolve({ ok: true, address });
          });
          s.once('timeout', () => {
            s.destroy();
            resolve({ ok: false, error: 'timeout (5 s): filtrata o host irraggiungibile' });
          });
          s.once('error', (e: NodeJS.ErrnoException) => resolve({ ok: false, error: e.code === 'ECONNREFUSED' ? 'rifiutata: host raggiungibile, porta chiusa' : e.code ?? e.message }));
        });
        return { type: t.type, host: t.host, port: t.port, ms: Math.round(performance.now() - t0), ...r };
      }
      case 'http': {
        const url = new URL(t.url);
        const t0 = performance.now();
        let res: Response;
        try {
          res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(10_000), headers: { 'user-agent': 'GIGI-OS-diagnostica' } });
        } catch (e) {
          return { type: t.type, ok: false, error: ((e as Error & { cause?: { code?: string } }).cause?.code ?? (e as Error).message), ms: Math.round(performance.now() - t0) };
        }
        const ms = Math.round(performance.now() - t0);
        void res.body?.cancel().catch(() => {});
        const cert = url.protocol === 'https:' ? await certInfo(url.hostname, Number(url.port || 443)) : null;
        // Solo metadati: il corpo della risposta non viene mai restituito
        return {
          type: t.type,
          ok: res.status < 400,
          status: res.status,
          ms,
          location: res.headers.get('location'),
          server: res.headers.get('server'),
          contentType: res.headers.get('content-type'),
          hsts: res.headers.has('strict-transport-security'),
          cert,
          total: Math.round(performance.now() - started),
        };
      }
    }
  }

  // ── Speed test ──
  speedState() {
    return { current: this.speed, history: JSON.parse(getSetting(this.db, 'net.speedHistory') ?? '[]') as unknown[] };
  }

  startSpeed() {
    if (this.speed?.status === 'running') throw fail(409, 'Un test di velocità è già in corso');
    if (this.speed?.endedAt && Date.now() - this.speed.endedAt < 60_000) throw fail(429, 'Attendi un minuto tra un test e l’altro');
    const s: Speed = { id: randomUUID(), status: 'running', phase: 'latency', startedAt: Date.now(), endedAt: null, latency: null, jitter: null, download: null, upload: null, live: null, error: null };
    this.speed = s;
    void this.runSpeed(s)
      .then(() => {
        s.status = 'ok';
        s.phase = 'done';
        const hist = JSON.parse(getSetting(this.db, 'net.speedHistory') ?? '[]') as unknown[];
        hist.unshift({ t: s.startedAt, latency: s.latency, jitter: s.jitter, download: s.download, upload: s.upload });
        setSetting(this.db, 'net.speedHistory', JSON.stringify(hist.slice(0, 30)));
      })
      .catch((e) => {
        s.status = 'error';
        s.error = (e as Error).message;
      })
      .finally(() => {
        s.endedAt = Date.now();
        s.live = null;
      });
    return s;
  }

  private async runSpeed(s: Speed) {
    const lat: number[] = [];
    for (let i = 0; i < 10; i++) {
      const t0 = performance.now();
      const r = await fetch(`${CF}/__down?bytes=0`, { signal: AbortSignal.timeout(5000), cache: 'no-store' });
      await r.arrayBuffer();
      lat.push(performance.now() - t0);
    }
    lat.sort((a, b) => a - b);
    s.latency = Math.round(lat[Math.floor(lat.length / 2)] * 10) / 10;
    s.jitter = Math.round((lat.slice(1).reduce((a, v, i) => a + Math.abs(v - lat[i]), 0) / (lat.length - 1)) * 10) / 10;

    s.phase = 'download';
    let bytes = 0;
    const t0 = performance.now();
    const tick = setInterval(() => (s.live = Math.round(((bytes * 8) / ((performance.now() - t0) / 1000) / 1e6) * 10) / 10), 500);
    try {
      await Promise.all(
        [0, 1, 2, 3].map(async () => {
          const r = await fetch(`${CF}/__down?bytes=6250000`, { signal: AbortSignal.timeout(60_000), cache: 'no-store' });
          if (!r.ok || !r.body) throw new Error(`download: HTTP ${r.status}`);
          for await (const chunk of r.body) bytes += (chunk as Uint8Array).length;
        }),
      );
    } finally {
      clearInterval(tick);
    }
    s.download = Math.round(((bytes * 8) / ((performance.now() - t0) / 1000) / 1e6) * 10) / 10;

    s.phase = 'upload';
    s.live = null;
    const chunk = Buffer.alloc(2_500_000, 0x61);
    const u0 = performance.now();
    await Promise.all(
      [0, 1, 2, 3].map(async () => {
        const r = await fetch(`${CF}/__up`, { method: 'POST', body: chunk, signal: AbortSignal.timeout(60_000), headers: { 'content-type': 'application/octet-stream' } });
        await r.arrayBuffer();
        if (!r.ok) throw new Error(`upload: HTTP ${r.status}`);
      }),
    );
    s.upload = Math.round(((chunk.length * 4 * 8) / ((performance.now() - u0) / 1000) / 1e6) * 10) / 10;
  }

  // ── Dispositivi in LAN ──
  private async arp() {
    const out: { ip: string; mac: string; iface: string }[] = [];
    try {
      for (const l of (await readFile(path.join(PROC, 'net/arp'), 'utf8')).split('\n').slice(1)) {
        const c = l.trim().split(/\s+/);
        if (c.length < 6 || c[2] === '0x0' || c[3] === '00:00:00:00:00:00') continue;
        if (c[5].startsWith('br-') || c[5].startsWith('docker') || c[5].startsWith('veth')) continue;
        out.push({ ip: c[0], mac: c[3].toLowerCase(), iface: c[5] });
      }
    } catch {}
    return out;
  }

  private known(): Known {
    return JSON.parse(getSetting(this.db, 'net.devices') ?? '{}') as Known;
  }

  /** Aggiorna l'elenco dei dispositivi visti. Ritorna i MAC nuovi (mai visti prima). */
  private async remember(list: { ip: string; mac: string }[], names: Record<string, string | null> = {}) {
    const known = this.known();
    const first = Object.keys(known).length === 0;
    const fresh: string[] = [];
    const now = Date.now();
    for (const d of list) {
      const k = known[d.mac];
      if (!k) {
        fresh.push(d.mac);
        known[d.mac] = { ip: d.ip, firstSeen: now, lastSeen: now, name: names[d.ip] ?? null };
      } else {
        k.ip = d.ip;
        k.lastSeen = now;
        if (names[d.ip]) k.name = names[d.ip];
      }
    }
    setSetting(this.db, 'net.devices', JSON.stringify(known));
    if (!first)
      for (const mac of fresh)
        this.events.add('warning', 'rete', `Nuovo dispositivo in rete: ${known[mac].ip} (${mac})`, known[mac].name ? `Nome: ${known[mac].name}` : 'Nome non risolto', `newdev:${mac}`);
    return fresh;
  }

  async devices() {
    const arp = await this.arp();
    const known = this.known();
    const gw = (await this.routes()).v4.find((r) => r.isDefault)?.gateway ?? null;
    const online = new Set(arp.map((a) => a.mac));
    return {
      scanning: this.scanning,
      gateway: gw,
      devices: Object.entries(known)
        .map(([mac, k]) => ({ mac, ...k, online: online.has(mac), gateway: k.ip === gw, randomMac: /^.[26ae]/i.test(mac) }))
        .concat(arp.filter((a) => !known[a.mac]).map((a) => ({ mac: a.mac, ip: a.ip, firstSeen: 0, lastSeen: 0, name: null, online: true, gateway: a.ip === gw, randomMac: /^.[26ae]/i.test(a.mac) })))
        .sort((a, b) => ipNum(a.ip) - ipNum(b.ip)),
    };
  }

  /** Ping sweep della LAN (solo /24 o più piccole) per popolare la tabella ARP, poi nomi via DNS inverso. */
  async scan() {
    if (this.scanning) throw fail(409, 'Scansione già in corso');
    const ov = await this.routes();
    const def = ov.v4.find((r) => r.isDefault);
    const lan = ov.v4.find((r) => !r.isDefault && r.iface === def?.iface && !r.gateway);
    if (!lan) throw fail(503, 'Rete LAN non individuata');
    const [baseIp, prefix] = lan.destination.split('/');
    if (Number(prefix) < 24) throw fail(400, `Rete /${prefix} troppo grande per una scansione`);
    this.scanning = true;
    try {
      const base = baseIp.split('.').map(Number);
      const size = 2 ** (32 - Number(prefix));
      const ips = Array.from({ length: size - 2 }, (_, i) => `${base[0]}.${base[1]}.${base[2]}.${base[3] + i + 1}`);
      for (let i = 0; i < ips.length; i += 48) await Promise.all(ips.slice(i, i + 48).map((ip) => run('ping', ['-n', '-c', '1', '-W', '1', ip], 3000)));
      const arp = await this.arp();
      const names: Record<string, string | null> = {};
      await Promise.all(arp.map(async (a) => (names[a.ip] = (await withTimeout(dns.reverse(a.ip), 1500).catch(() => []))[0] ?? null)));
      const fresh = await this.remember(arp, names);
      return { found: arp.length, new: fresh.length };
    } finally {
      this.scanning = false;
    }
  }

  forget(mac: string) {
    const k = this.known();
    delete k[mac.toLowerCase()];
    setSetting(this.db, 'net.devices', JSON.stringify(k));
  }

  rename(mac: string, name: string | null) {
    const k = this.known();
    const d = k[mac.toLowerCase()];
    if (!d) throw fail(404, 'Dispositivo sconosciuto');
    d.name = name;
    setSetting(this.db, 'net.devices', JSON.stringify(k));
  }

  // ── Wake-on-LAN ──
  async wake(mac: string) {
    const bytes = Buffer.from(mac.replace(/[:-]/g, ''), 'hex');
    const packet = Buffer.concat([Buffer.alloc(6, 0xff), ...Array.from({ length: 16 }, () => bytes)]);
    const targets = new Set(['255.255.255.255']);
    const def = (await this.routes()).v4.find((r) => r.isDefault);
    for (const a of os.networkInterfaces()[def?.iface ?? ''] ?? []) {
      if (a.family !== 'IPv4') continue;
      const ip = a.address.split('.').map(Number);
      const mask = a.netmask.split('.').map(Number);
      targets.add(ip.map((o, i) => (o & mask[i]) | (~mask[i] & 255)).join('.'));
    }
    const sock = dgram.createSocket('udp4');
    try {
      await new Promise<void>((r, j) => sock.bind(0, () => r()).once('error', j));
      sock.setBroadcast(true);
      for (const t of targets) for (const port of [9, 7]) await new Promise<void>((r, j) => sock.send(packet, port, t, (e) => (e ? j(e) : r())));
    } finally {
      sock.close();
    }
    return { sent: [...targets] };
  }

  // ── Monitoraggio facoltativo ──
  monitorSettings(): Monitor {
    return { publicIp: false, devices: false, ...(JSON.parse(getSetting(this.db, 'net.monitor') ?? '{}') as Partial<Monitor>) };
  }
  setMonitor(m: Monitor) {
    setSetting(this.db, 'net.monitor', JSON.stringify(m));
  }
  startMonitor(log: (m: string, e?: Record<string, unknown>) => void) {
    setInterval(() => {
      const m = this.monitorSettings();
      if (m.publicIp) void this.publicIp(true).catch((e) => log('IP pubblico non verificabile', { err: (e as Error).message }));
      // Solo lettura passiva della tabella ARP: nessuna scansione attiva in background
      if (m.devices) void this.arp().then((a) => this.remember(a)).catch(() => {});
    }, 15 * 60_000).unref();
  }
}

const ipNum = (ip: string) => ip.split('.').reduce((a, o) => a * 256 + Number(o), 0);
const withTimeout = <T>(p: Promise<T>, ms: number) => Promise.race([p, new Promise<never>((_, j) => setTimeout(() => j(new Error('timeout')), ms))]);

async function resolve(r: dns.Resolver, name: string, record: string): Promise<string[]> {
  switch (record) {
    case 'AAAA':
      return r.resolve6(name);
    case 'MX':
      return (await r.resolveMx(name)).sort((a, b) => a.priority - b.priority).map((m) => `${m.priority} ${m.exchange}`);
    case 'TXT':
      return (await r.resolveTxt(name)).map((t) => t.join(''));
    case 'NS':
      return r.resolveNs(name);
    case 'CNAME':
      return r.resolveCname(name);
    case 'PTR':
      return r.reverse(name);
    default:
      return r.resolve4(name);
  }
}

function certInfo(host: string, port: number) {
  return new Promise<Record<string, unknown> | null>((resolve) => {
    const s = tls.connect({ host, port, servername: net.isIP(host) ? undefined : host, rejectUnauthorized: false, timeout: 5000 }, () => {
      const c = s.getPeerCertificate();
      const validTo = c.valid_to ? new Date(c.valid_to).getTime() : null;
      resolve({
        subject: c.subject?.CN ?? null,
        issuer: c.issuer?.O ?? c.issuer?.CN ?? null,
        validTo,
        daysLeft: validTo ? Math.floor((validTo - Date.now()) / 86400_000) : null,
        san: c.subjectaltname?.split(', ').slice(0, 10) ?? [],
        trusted: s.authorized,
        error: s.authorizationError ? String(s.authorizationError) : null,
        protocol: s.getProtocol(),
      });
      s.end();
    });
    s.once('error', () => resolve(null));
    s.once('timeout', () => {
      s.destroy();
      resolve(null);
    });
  });
}

// ───────────── Route ─────────────

const host = z.string().trim().regex(HOST_RE, 'Host non valido');
const testInput = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ping'), host, count: z.number().int().min(1).max(10).optional() }),
  z.object({ type: z.literal('tracepath'), host }),
  z.object({ type: z.literal('dns'), name: z.string().trim().min(1).max(253).regex(/^[a-zA-Z0-9._:-]+$/), record: z.enum(['A', 'AAAA', 'MX', 'TXT', 'NS', 'CNAME', 'PTR']).optional(), server: z.string().refine((s) => net.isIP(s) > 0, 'Server DNS: indirizzo IP').optional() }),
  z.object({ type: z.literal('tcp'), host, port: z.number().int().min(1).max(65535) }),
  z.object({ type: z.literal('http'), url: z.string().url().max(2000).refine((u) => /^https?:\/\//i.test(u), 'Solo http o https') }),
]);
type TestInput = z.infer<typeof testInput>;

export function registerNetwork(app: FastifyInstance, n: Network, audit: Audit, viewer: object, admin: object) {
  const limited = (max: number) => ({ ...admin, config: { rateLimit: { max, timeWindow: '1 minute' } } });
  const who = (req: FastifyRequest) => req.user?.username ?? '?';

  app.get('/api/v1/network/overview', viewer, async () => n.overview());
  app.get('/api/v1/network/listening', admin, async () => n.listening());
  app.get('/api/v1/network/connections', admin, async () => n.connections());
  app.get('/api/v1/network/firewall', admin, async () => n.firewall());
  app.get('/api/v1/network/firewall/blocked', admin, async (req) => {
    const hours = Math.min(Math.max(Number((req.query as { hours?: string }).hours ?? 24) || 24, 1), 168);
    return n.blocked(hours);
  });
  app.get('/api/v1/network/public-ip', limited(20), async (req) => n.publicIp((req.query as { refresh?: string }).refresh === '1'));

  app.post('/api/v1/network/test', limited(30), async (req) => {
    const t = testInput.parse(req.body);
    const target = 'host' in t ? t.host : 'url' in t ? new URL(t.url).host : t.name;
    audit.log(req, `network.test.${t.type}`, 'ok', target);
    return n.test(t);
  });

  app.get('/api/v1/network/speedtest', admin, async () => n.speedState());
  app.post('/api/v1/network/speedtest', limited(3), async (req) => {
    const s = n.startSpeed();
    audit.log(req, 'network.speedtest', 'ok', null);
    return s;
  });

  app.get('/api/v1/network/devices', admin, async () => n.devices());
  app.post('/api/v1/network/devices/scan', limited(4), async (req) => {
    audit.log(req, 'network.scan', 'ok', null);
    return n.scan();
  });
  app.patch('/api/v1/network/devices/:mac', admin, async (req, reply) => {
    const { mac } = req.params as { mac: string };
    if (!MAC_RE.test(mac)) return reply.code(400).send({ error: 'MAC non valido' });
    const b = z.object({ name: z.string().trim().max(60).nullable() }).parse(req.body);
    n.rename(mac, b.name || null);
    return { ok: true };
  });
  app.delete('/api/v1/network/devices/:mac', admin, async (req, reply) => {
    const { mac } = req.params as { mac: string };
    if (!MAC_RE.test(mac)) return reply.code(400).send({ error: 'MAC non valido' });
    n.forget(mac);
    return { ok: true };
  });

  app.post('/api/v1/network/wol', limited(20), async (req) => {
    const { mac } = z.object({ mac: z.string().regex(MAC_RE, 'MAC non valido') }).parse(req.body);
    const r = await n.wake(mac);
    audit.log(req, 'network.wol', 'ok', mac.toLowerCase(), { by: who(req) });
    return r;
  });

  app.get('/api/v1/network/monitor', admin, async () => n.monitorSettings());
  app.put('/api/v1/network/monitor', admin, async (req) => {
    const m = z.object({ publicIp: z.boolean(), devices: z.boolean() }).parse(req.body);
    n.setMonitor(m);
    audit.log(req, 'network.monitor', 'ok', null, m);
    return m;
  });
}
