// Vault credenziali: AES-256-GCM con chiave master letta da file esterno al database.
// AAD = id dell'integrazione, così un segreto cifrato non può essere spostato su un'altra riga.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';

const VERSION = 'v1';

export class Vault {
  private key: Buffer;

  constructor(key: Buffer) {
    if (key.length !== 32) throw new Error('La chiave master deve essere di 32 byte');
    this.key = key;
  }

  static fromFile(file: string): Vault {
    const raw = readFileSync(file, 'utf8').trim();
    const key = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
    return new Vault(key);
  }

  encrypt(plaintext: string, aad: string): string {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.key, iv);
    c.setAAD(Buffer.from(aad));
    const ct = Buffer.concat([c.update(plaintext, 'utf8'), c.final()]);
    return `${VERSION}:${Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64')}`;
  }

  decrypt(payload: string, aad: string): string {
    const [ver, data] = payload.split(':');
    if (ver !== VERSION || !data) throw new Error('Formato segreto non supportato');
    const buf = Buffer.from(data, 'base64');
    const d = createDecipheriv('aes-256-gcm', this.key, buf.subarray(0, 12));
    d.setAAD(Buffer.from(aad));
    d.setAuthTag(buf.subarray(12, 28));
    return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8');
  }
}
