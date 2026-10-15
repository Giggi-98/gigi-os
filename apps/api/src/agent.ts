// Client verso gigi-agent tramite socket Unix.
import http from 'node:http';
import type { Readable } from 'node:stream';

export class AgentError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

export class AgentClient {
  constructor(private socketPath: string) {}

  private raw(method: string, path: string, timeoutMs = 15000): Promise<http.IncomingMessage> {
    return new Promise((resolve, reject) => {
      const req = http.request({ socketPath: this.socketPath, path, method, timeout: timeoutMs }, resolve);
      req.on('timeout', () => req.destroy(new AgentError('Agent non risponde (timeout)', 504)));
      req.on('error', (e) =>
        reject(e instanceof AgentError ? e : new AgentError(`Agent non raggiungibile: ${(e as NodeJS.ErrnoException).code ?? e.message}`, 503)),
      );
      req.end();
    });
  }

  async json<T = unknown>(method: string, path: string, timeoutMs?: number): Promise<T> {
    const res = await this.raw(method, path, timeoutMs);
    const chunks: Buffer[] = [];
    for await (const c of res) chunks.push(c as Buffer);
    const text = Buffer.concat(chunks).toString('utf8');
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      throw new AgentError('Risposta agent non valida', 502);
    }
    if ((res.statusCode ?? 500) >= 400) throw new AgentError((body as { error?: string })?.error ?? 'Errore agent', res.statusCode ?? 500);
    return body as T;
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
