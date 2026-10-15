// Fetch verso servizi configurati con difese SSRF: solo http/https, nessuna credenziale nell'URL,
// destinazioni risolte e verificate contro le CIDR consentite, redirect NON seguiti, timeout e limite di dimensione.
// Limite noto: tra la verifica DNS e la connessione esiste una finestra (TOCTOU); per destinazioni LAN fisse è accettabile.
import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';

export class TargetError extends Error {
  constructor(message: string, public code: 'forbidden_target' | 'bad_url' | 'redirect' | 'too_large' | 'timeout' | 'network') {
    super(message);
  }
}

export function buildBlockList(cidrs: string[]): BlockList {
  const bl = new BlockList();
  for (const c of cidrs) {
    const [addr, bits] = c.split('/');
    const type = isIP(addr) === 6 ? 'ipv6' : 'ipv4';
    if (bits === undefined) bl.addAddress(addr, type);
    else bl.addSubnet(addr, Number(bits), type);
  }
  return bl;
}

export function validateUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new TargetError('URL non valido', 'bad_url');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new TargetError('Sono ammessi solo http e https', 'bad_url');
  if (u.username || u.password) throw new TargetError("Non inserire credenziali nell'URL: usa i campi di autenticazione", 'bad_url');
  return u;
}

export async function assertAllowed(u: URL, allowed: BlockList) {
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const addrs = isIP(host) ? [{ address: host, family: isIP(host) }] : await lookup(host, { all: true }).catch(() => []);
  if (addrs.length === 0) throw new TargetError(`Impossibile risolvere ${host}`, 'network');
  for (const a of addrs) {
    if (!allowed.check(a.address, a.family === 6 ? 'ipv6' : 'ipv4')) {
      throw new TargetError(`Destinazione ${a.address} non consentita (GIGI_ALLOWED_TARGETS)`, 'forbidden_target');
    }
  }
}

export type SafeResponse = { status: number; headers: Headers; body: Buffer; latency: number };

export async function safeFetch(
  allowed: BlockList,
  url: string,
  init: RequestInit & { timeoutMs?: number; maxBytes?: number } = {},
): Promise<SafeResponse> {
  const u = validateUrl(url);
  await assertAllowed(u, allowed);
  const started = Date.now();
  let res: Response;
  try {
    res = await fetch(u, { ...init, redirect: 'manual', signal: AbortSignal.timeout(init.timeoutMs ?? 8000) });
  } catch (e) {
    const err = e as Error;
    if (err.name === 'TimeoutError') throw new TargetError('Timeout della richiesta', 'timeout');
    throw new TargetError(`Connessione fallita: ${(err as { cause?: { code?: string } }).cause?.code ?? err.message}`, 'network');
  }
  if (res.status >= 300 && res.status < 400) throw new TargetError(`Redirect non seguito (${res.status})`, 'redirect');
  const max = init.maxBytes ?? 5 * 1024 * 1024;
  const chunks: Buffer[] = [];
  let size = 0;
  if (res.body) {
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      size += chunk.length;
      if (size > max) throw new TargetError('Risposta troppo grande', 'too_large');
      chunks.push(Buffer.from(chunk));
    }
  }
  return { status: res.status, headers: res.headers, body: Buffer.concat(chunks), latency: Date.now() - started };
}
