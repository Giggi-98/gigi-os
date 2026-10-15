-- 002 — canali di notifica, regole di automazione, storico invii. Append-only.

CREATE TABLE notify_channels (
  id         TEXT PRIMARY KEY,
  type       TEXT NOT NULL CHECK (type IN ('homeassistant', 'ntfy', 'telegram', 'webhook')),
  name       TEXT NOT NULL,
  config     TEXT NOT NULL DEFAULT '{}',
  secret_enc TEXT,
  enabled    INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE automation_rules (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  enabled      INTEGER NOT NULL DEFAULT 1,
  sources      TEXT NOT NULL DEFAULT '[]',
  min_level    TEXT NOT NULL DEFAULT 'warning' CHECK (min_level IN ('info', 'warning', 'error')),
  match_text   TEXT,
  channels     TEXT NOT NULL DEFAULT '[]',
  throttle_min INTEGER NOT NULL DEFAULT 30,
  quiet_from   TEXT,
  quiet_to     TEXT,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

CREATE TABLE notifications (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  ts        INTEGER NOT NULL,
  rule_id   TEXT,
  rule_name TEXT,
  channel   TEXT,
  title     TEXT NOT NULL,
  status    TEXT NOT NULL CHECK (status IN ('sent', 'failed', 'throttled', 'quiet')),
  error     TEXT
);
CREATE INDEX notifications_ts ON notifications(ts);
CREATE INDEX notifications_rule ON notifications(rule_id, title, ts);
