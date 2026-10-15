// Client verso gigi-agent tramite socket Unix.
import http from 'node:http';
import type { Readable } from 'node:stream';

export class AgentError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

export class AgentClient {
  constructor(private socketPath: string, private label = 'Agent') {}

  private raw(method: string, path: string, timeoutMs = 15000, body?: unknown): Promise<http.IncomingMessage> {
    return new Promise((resolve, reject) => {
      const data = body === undefined ? undefined : JSON.stringify(body);
      const req = http.request(
        {
          socketPath: this.socketPath,
          path,
          method,
          timeout: timeoutMs,
          headers: data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : undefined,
        },
        resolve,
      );
      req.on('timeout', () => req.destroy(new AgentError(`${this.label} non risponde (timeout)`, 504)));
      req.on('error', (e) =>
        reject(e instanceof AgentError ? e : new AgentError(`${this.label} non raggiungibile: ${(e as NodeJS.ErrnoException).code ?? e.message}`, 503)),
      );
      req.end(data);
    });
  }

  async json<T = unknown>(method: string, path: string, timeoutMs?: number, body?: unknown): Promise<T> {
    const res = await this.raw(method, path, timeoutMs, body);
    const chunks: Buffer[] = [];
    for await (const c of res) chunks.push(c as Buffer);
    const text = Buffer.concat(chunks).toString('utf8');
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      throw new AgentError(`Risposta ${this.label} non valida`, 502);
    }
    if ((res.statusCode ?? 500) >= 400) throw new AgentError((parsed as { error?: string })?.error ?? `Errore ${this.label}`, res.statusCode ?? 500);
    return parsed as T;
  }

  async stream(path: string): Promise<Readable> {
    const res = await this.raw('GET', path, 0);
    if ((res.statusCode ?? 500) >= 400) {
      const chunks: Buffer[] = [];
      for await (const c of res) chunks.push(c as Buffer);
      let msg = 'Errore agent';
      try {
        msg = JSON.parse(Buffer.concat(chunks).toString()).error ?? msg;
      } catch {}
      throw new AgentError(msg, res.statusCode ?? 500);
    }
    return res;
  }
}
