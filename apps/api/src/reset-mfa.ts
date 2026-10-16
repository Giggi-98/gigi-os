// Recupero di emergenza (D-029): azzera la verifica in due passaggi di un utente e ne chiude le sessioni.
// Uso, sul server: docker exec gigi-api node apps/api/dist/reset-mfa.js <utente>
// Al login successivo l'utente (se admin o operatore) deve configurarla di nuovo.
import { config } from './config.js';
import { openDb } from './db.js';

const username = process.argv[2];
if (!username || !/^[a-zA-Z0-9._-]{3,40}$/.test(username)) {
  console.error('Uso: node apps/api/dist/reset-mfa.js <utente>');
  process.exit(2);
}
const db = openDb(config.dataDir);
const u = db.prepare('SELECT id, username FROM users WHERE username = ?').get(username) as { id: string; username: string } | undefined;
if (!u) {
  console.error(`Utente «${username}» non trovato`);
  process.exit(1);
}
const had = db.prepare('DELETE FROM user_mfa WHERE user_id = ?').run(u.id).changes > 0;
db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id);
db.prepare('INSERT INTO audit_log (ts, user_id, username, action, target, result, ip, details) VALUES (?, NULL, ?, ?, ?, ?, NULL, ?)').run(
  Date.now(),
  'console del server',
  'mfa.reset',
  u.username,
  'ok',
  JSON.stringify({ via: 'reset-mfa.js', eraAttiva: had }),
);
db.close();
console.log(had ? `Verifica in due passaggi azzerata per ${u.username}; sessioni chiuse.` : `${u.username} non aveva la verifica in due passaggi; sessioni chiuse.`);
