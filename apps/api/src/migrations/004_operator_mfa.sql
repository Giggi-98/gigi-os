-- gigi:foreign-keys-off
-- 004 — ruolo «operator» (D-028) e verifica in due passaggi TOTP (D-029).
-- SQLite non modifica un CHECK: la tabella users viene ricostruita con la procedura ufficiale
-- (chiavi esterne disattivate da migrate(), poi foreign_key_check), così sessioni e layout restano.

CREATE TABLE users_new (
  id            TEXT PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('admin', 'operator', 'viewer')),
  disabled      INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  last_login_at INTEGER
);
INSERT INTO users_new (id, username, password_hash, role, disabled, created_at, updated_at, last_login_at)
  SELECT id, username, password_hash, role, disabled, created_at, updated_at, last_login_at FROM users;
DROP TABLE users;
ALTER TABLE users_new RENAME TO users;

-- Segreto TOTP cifrato nel vault (AAD «mfa:<user_id>»); enabled = 0 finché l'utente non conferma un codice.
CREATE TABLE user_mfa (
  user_id     TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  secret_enc  TEXT NOT NULL,
  enabled     INTEGER NOT NULL DEFAULT 0,
  last_step   INTEGER NOT NULL DEFAULT 0,  -- ultimo intervallo di 30 s usato: lo stesso codice non vale due volte
  recovery    TEXT NOT NULL DEFAULT '[]',  -- SHA-256 dei codici di recupero non ancora usati
  created_at  INTEGER NOT NULL,
  enabled_at  INTEGER
);
