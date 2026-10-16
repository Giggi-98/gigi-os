// Rilevamento aggiornamenti (D-032), sola lettura: digest delle immagini sul registry tramite il demone Docker
// (GET /distribution/{ref}/json: nessun download, richieste HEAD che non consumano i limiti di Docker Hub)
// e stato dei pacchetti del sistema operativo dai file che Ubuntu/Debian già mantengono.
import { existsSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import { docker } from './docker.js';

type ImageCheck = {
  ref: string;
  containers: string[];
  project: string | null;
  workingDir: string | null;
  status: 'aggiornato' | 'disponibile' | 'locale' | 'errore';
  localDigest: string | null;
  remoteDigest: string | null;
  error: string | null;
};

const withTimeout = <T>(p: Promise<T>, ms: number) => Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout del registry')), ms))]);

export async function imageUpdates(): Promise<ImageCheck[]> {
  const list = await docker.listContainers({ all: true });
  const byRef = new Map<string, { containers: string[]; project: string | null; workingDir: string | null; imageId: string }>();
  for (const c of list) {
    const ref = c.Image.startsWith('sha256:') ? null : c.Image;
    if (!ref) continue;
    const e = byRef.get(ref) ?? { containers: [], project: c.Labels?.['com.docker.compose.project'] ?? null, workingDir: c.Labels?.['com.docker.compose.project.working_dir'] ?? null, imageId: c.ImageID };
    e.containers.push(c.Names[0]?.replace(/^\//, '') ?? c.Id.slice(0, 12));
    byRef.set(ref, e);
  }
  const out: ImageCheck[] = [];
  const queue = [...byRef.entries()];
  // Al massimo 3 richieste in parallelo verso i registry
  await Promise.all(
    Array.from({ length: 3 }, async () => {
      for (let next = queue.shift(); next; next = queue.shift()) {
        const [ref, e] = next;
        const base = { ref, containers: e.containers, project: e.project, workingDir: e.workingDir };
        let digests: string[] = [];
        try {
          digests = ((await docker.getImage(e.imageId).inspect()).RepoDigests ?? []).map((d) => d.split('@')[1]).filter(Boolean);
        } catch {}
        if (!digests.length) {
          out.push({ ...base, status: 'locale', localDigest: null, remoteDigest: null, error: null });
          continue;
        }
        try {
          const dist = (await withTimeout(docker.getImage(ref).distribution(), 20_000)) as { Descriptor?: { digest?: string } };
          const remote = dist.Descriptor?.digest ?? null;
          out.push({ ...base, status: remote && !digests.includes(remote) ? 'disponibile' : 'aggiornato', localDigest: digests[0], remoteDigest: remote, error: null });
        } catch (err) {
          out.push({ ...base, status: 'errore', localDigest: digests[0], remoteDigest: null, error: String((err as Error).message ?? err).slice(0, 200) });
        }
      }
    }),
  );
  return out.sort((a, b) => a.ref.localeCompare(b.ref));
}

const NOTIFIER = '/host/update-notifier/updates-available';
const PERIODIC = '/host/apt-periodic';
const BOOT = '/host/boot';
const UNITS = '/host/units/etc';

const mtime = async (p: string) => {
  try {
    return (await stat(p)).mtimeMs;
  } catch {
    return null;
  }
};

/** Confronto di versioni del kernel (es. 7.0.0-38-generic): numeri a pezzi, il resto come testo. */
export function kernelCompare(a: string, b: string) {
  const pa = a.split(/[.-]/);
  const pb = b.split(/[.-]/);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? '';
    const y = pb[i] ?? '';
    const nx = Number(x);
    const ny = Number(y);
    const c = !Number.isNaN(nx) && !Number.isNaN(ny) ? nx - ny : x.localeCompare(y);
    if (c) return c;
  }
  return 0;
}

/** Testo di update-notifier: «N updates can be applied immediately», «M of these updates are standard security updates», righe ESM. */
export function parseNotifier(txt: string) {
  const num = (re: RegExp) => {
    const m = re.exec(txt);
    return m ? Number(m[1]) : null;
  };
  return {
    upgradable: num(/(\d+) updates? can be applied immediately/i) ?? (/no updates/i.test(txt) ? 0 : null),
    security: num(/(\d+) of these updates? (?:are|is) (?:a )?(?:standard )?security updates?/i) ?? 0,
    esm: num(/(\d+) additional security updates? can be applied with ESM/i) ?? 0,
  };
}

export async function hostUpdates() {
  const [notifierTxt, notifierAt, updateAt, successAt, unattendedAt, kernels] = await Promise.all([
    readFile(NOTIFIER, 'utf8').catch(() => null),
    mtime(NOTIFIER),
    mtime(`${PERIODIC}/update-stamp`),
    mtime(`${PERIODIC}/update-success-stamp`),
    mtime(`${PERIODIC}/unattended-upgrades-stamp`),
    readdir(BOOT).catch(() => null),
  ]);
  const running = os.release();
  const installed = (kernels ?? []).filter((f) => /^vmlinuz-\d/.test(f)).map((f) => f.slice('vmlinuz-'.length)).sort(kernelCompare);
  const newest = installed[installed.length - 1] ?? null;
  return {
    supported: notifierTxt !== null || updateAt !== null,
    packages: notifierTxt ? { ...parseNotifier(notifierTxt), at: notifierAt } : null,
    apt: { lastUpdate: updateAt, lastSuccess: successAt, lastUnattended: unattendedAt },
    unattendedEnabled: existsSync(`${UNITS}/multi-user.target.wants/unattended-upgrades.service`) || existsSync(`${UNITS}/timers.target.wants/apt-daily-upgrade.timer`),
    kernel: { running, newest, rebootNeeded: !!newest && kernelCompare(newest, running) > 0 },
  };
}
