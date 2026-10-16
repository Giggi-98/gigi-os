-- 007 — dispositivi attendibili per la verifica in due passaggi (D-036): dopo il codice, un browser può saltare
-- la 2FA per un periodo scelto dall'admin. Nel database c'è solo lo SHA-256 del token del cookie.
CREATE TABLE trusted_devices (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   TEXT NOT NULL UNIQUE,
  label        TEXT NOT NULL,
  ip           TEXT,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  last_used_at INTEGER
);
CREATE INDEX trusted_devices_user ON trusted_devices (user_id);
