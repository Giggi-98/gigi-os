-- 001 — schema iniziale GIGI OS. Append-only: non modificare dopo il rilascio, aggiungere 002_*.sql.

CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('admin', 'viewer')),
  disabled      INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  last_login_at INTEGER
);

CREATE TABLE sessions (
  token_hash  TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf        TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  last_seen   INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  ip          TEXT,
  user_agent  TEXT
);
CREATE INDEX sessions_user ON sessions(user_id);

CREATE TABLE login_attempts (
  key        TEXT NOT NULL,
  ts         INTEGER NOT NULL
);
CREATE INDEX login_attempts_key ON login_attempts(key, ts);

CREATE TABLE audit_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ts         INTEGER NOT NULL,
  user_id    TEXT,
  username   TEXT,
  action     TEXT NOT NULL,
  target     TEXT,
  result     TEXT NOT NULL CHECK (result IN ('ok', 'denied', 'error')),
  ip         TEXT,
  details    TEXT
);
CREATE INDEX audit_ts ON audit_log(ts);

CREATE TABLE integrations (
  id           TEXT PRIMARY KEY,
  type         TEXT NOT NULL,
  name         TEXT NOT NULL,
  base_url     TEXT NOT NULL,
  auth_type    TEXT NOT NULL,
  secret_enc   TEXT,
  config       TEXT NOT NULL DEFAULT '{}',
  enabled      INTEGER NOT NULL DEFAULT 1,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  last_status  TEXT,
  last_message TEXT,
  last_checked INTEGER,
  last_latency INTEGER
);

CREATE TABLE layouts (
  user_id    TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  layout     TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE events (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  ts      INTEGER NOT NULL,
  level   TEXT NOT NULL CHECK (level IN ('info', 'warning', 'error')),
  source  TEXT NOT NULL,
  title   TEXT NOT NULL,
  details TEXT,
  dedup   TEXT
);
CREATE INDEX events_ts ON events(ts);
CREATE INDEX events_dedup ON events(dedup, ts);
