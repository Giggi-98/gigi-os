// Oscuramento dei segreti in variabili d'ambiente, argomenti e righe di log.
// Euristica deliberatamente prudente: meglio oscurare un valore innocuo che mostrare un token.

const SENSITIVE_KEY = /(pass(word|wd)?|secret|token|api[_-]?key|apikey|auth|credential|cookie|session|private|signature|salt|dsn|cert)/i;
const LONG_OPAQUE = /^[A-Za-z0-9+/=_\-.]{24,}$/;

export const REDACTED = '••••••';

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY.test(key);
}

export function redactValue(key: string, value: string): string {
  if (value === '') return value;
  if (isSensitiveKey(key)) return REDACTED;
  if (LONG_OPAQUE.test(value) && !value.includes('/')) return REDACTED;
  // URL con credenziali incorporate: scheme://user:pass@host
  return value.replace(/(\w+:\/\/)([^/\s:@]+):([^/\s@]+)@/g, `$1$2:${REDACTED}@`);
}

export function redactEnv(env: string[] | undefined): { key: string; value: string; redacted: boolean }[] {
  return (env ?? []).map((entry) => {
    const i = entry.indexOf('=');
    const key = i === -1 ? entry : entry.slice(0, i);
    const raw = i === -1 ? '' : entry.slice(i + 1);
    const value = redactValue(key, raw);
    return { key, value, redacted: value !== raw };
  });
}

const LINE_PATTERNS: [RegExp, string][] = [
  [/(authorization:\s*(bearer|basic|mediabrowser)\s+)[^\s,]+/gi, `$1${REDACTED}`],
  [/((?:api[_-]?key|apikey|token|access_token|password|passwd|pwd|secret|x-emby-token|x-mediabrowser-token)["']?\s*[=:]\s*["']?)[^\s"'&,;]+/gi, `$1${REDACTED}`],
  [/(\w+:\/\/)([^/\s:@]+):([^/\s@]+)@/g, `$1$2:${REDACTED}@`],
  [/\b(eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/g, REDACTED],
  // Forma discorsiva, es. Jellyfin: "Logging out access token 30f5f528…"
  [/\b((?:access|api|auth|session|refresh)?[ _-]?(?:token|key|secret)s?\s+)[A-Za-z0-9+/_=-]{20,}/gi, `$1${REDACTED}`],
];

export function redactLine(line: string): string {
  let out = line;
  for (const [re, rep] of LINE_PATTERNS) out = out.replace(re, rep);
  return out;
}

export function redactArgs(args: string[] | null | undefined): string[] {
  if (!args) return [];
  return args.map((a, idx, arr) => {
    const prev = idx > 0 ? arr[idx - 1] : '';
    if (/^--?[\w-]+$/.test(prev) && isSensitiveKey(prev)) return REDACTED;
    const m = /^(--?[\w-]+=)(.*)$/.exec(a);
    if (m && isSensitiveKey(m[1])) return m[1] + REDACTED;
    return redactLine(a);
  });
}
