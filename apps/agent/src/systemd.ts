// Stato dei servizi systemd via D-Bus, in SOLA LETTURA. L'agent gira come utente non privilegiato:
// systemd consente di leggere unità e proprietà, mentre start/stop/restart richiedono polkit (negati).
import dbus from 'dbus-next';

type UnitTuple = [string, string, string, string, string, string, string, number, string, string];

let bus: dbus.MessageBus | null = null;
let unavailable: { t: number; reason: string } | null = null;

export function markDbusFailure(err: unknown) {
  const msg = String((err as Error)?.message ?? err);
  unavailable = {
    t: Date.now(),
    reason: /AppArmor/i.test(msg)
      ? 'Bloccato dal profilo AppArmor di Docker: l’accesso a D-Bus dal container non è consentito'
      : /ENOENT|ECONNREFUSED/.test(msg)
        ? 'Socket D-Bus di sistema non disponibile nel container'
        : `D-Bus non disponibile: ${msg.slice(0, 160)}`,
  };
  try {
    bus?.disconnect();
  } catch {}
  bus = null;
}

/** Connessione verificata (Hello riuscito). Dopo un errore non si riprova per 5 minuti. */
async function getBus(): Promise<dbus.MessageBus> {
  if (unavailable && Date.now() - unavailable.t < 300_000) throw Object.assign(new Error(unavailable.reason), { status: 503 });
  if (bus) return bus;
  const b = dbus.systemBus();
  bus = b;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout di connessione a D-Bus')), 5000);
    b.on('connect', () => {
      clearTimeout(timer);
      resolve();
    });
    b.on('error', (e: unknown) => {
      clearTimeout(timer);
      reject(e);
    });
  }).catch((e) => {
    markDbusFailure(e);
    throw Object.assign(new Error(unavailable!.reason), { status: 503 });
  });
  unavailable = null;
  return b;
}

async function manager() {
  const obj = await (await getBus()).getProxyObject('org.freedesktop.systemd1', '/org/freedesktop/systemd1');
  return obj.getInterface('org.freedesktop.systemd1.Manager');
}

let cache: { t: number; data: unknown } | null = null;

export async function listServices() {
  if (cache && Date.now() - cache.t < 10_000) return cache.data;
  const m = await manager();
  const units = (await m.ListUnits()) as UnitTuple[];
  const data = units
    .filter((u) => u[0].endsWith('.service'))
    .map((u) => ({ name: u[0], description: u[1], load: u[2], active: u[3], sub: u[4] }))
    .sort((a, b) => (a.active === 'failed' ? -1 : 0) - (b.active === 'failed' ? -1 : 0) || a.name.localeCompare(b.name));
  cache = { t: Date.now(), data };
  return data;
}

const NAME = /^[a-zA-Z0-9@._:-]{1,200}\.service$/;

export async function serviceDetail(name: string) {
  if (!NAME.test(name)) throw Object.assign(new Error('Nome servizio non valido'), { status: 400 });
  const m = await manager();
  let path: string;
  try {
    path = (await m.GetUnit(name)) as string;
  } catch {
    throw Object.assign(new Error('Servizio non caricato'), { status: 404 });
  }
  const o = await (await getBus()).getProxyObject('org.freedesktop.systemd1', path);
  const p = o.getInterface('org.freedesktop.DBus.Properties');
  const get = async (iface: string, prop: string) => {
    try {
      const v = await p.Get(iface, prop);
      return v.value as unknown;
    } catch {
      return null;
    }
  };
  const U = 'org.freedesktop.systemd1.Unit';
  const S = 'org.freedesktop.systemd1.Service';
  const ts = (v: unknown) => (typeof v === 'bigint' && v > 0n ? Number(v / 1000n) : null);
  const num = (v: unknown) => (typeof v === 'bigint' ? (v === 18446744073709551615n ? null : Number(v)) : typeof v === 'number' ? v : null);
  return {
    name,
    description: (await get(U, 'Description')) as string,
    load: (await get(U, 'LoadState')) as string,
    active: (await get(U, 'ActiveState')) as string,
    sub: (await get(U, 'SubState')) as string,
    unitFileState: (await get(U, 'UnitFileState')) as string,
    fragment: (await get(U, 'FragmentPath')) as string,
    since: ts(await get(U, 'ActiveEnterTimestamp')),
    inactiveSince: ts(await get(U, 'InactiveEnterTimestamp')),
    mainPid: num(await get(S, 'MainPID')),
    memory: num(await get(S, 'MemoryCurrent')),
    cpuNs: num(await get(S, 'CPUUsageNSec')),
    tasks: num(await get(S, 'TasksCurrent')),
    restarts: num(await get(S, 'NRestarts')),
    result: (await get(S, 'Result')) as string | null,
    execMainStatus: num(await get(S, 'ExecMainStatus')),
    user: ((await get(S, 'User')) as string) || 'root',
    canControl: false,
  };
}
