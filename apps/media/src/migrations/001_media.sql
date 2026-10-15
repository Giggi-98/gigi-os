-- 001 — stato del motore media (database separato da quello dell'API). Append-only.

CREATE TABLE media_items (
  id              TEXT PRIMARY KEY,
  torrent_hash    TEXT NOT NULL,
  torrent_name    TEXT NOT NULL,
  category        TEXT,
  rel_path        TEXT NOT NULL,
  src_path        TEXT NOT NULL,
  size            INTEGER NOT NULL,
  mtime           INTEGER,
  ino             INTEGER,
  dev             INTEGER,
  first_seen      INTEGER NOT NULL,
  stable_since    INTEGER,
  status          TEXT NOT NULL,
  kind            TEXT,
  anime           INTEGER NOT NULL DEFAULT 0,
  parsed          TEXT,
  probe           TEXT,
  match           TEXT,
  plan            TEXT,
  confidence      INTEGER,
  reasons         TEXT,
  override        TEXT,
  error           TEXT,
  jf_item_id      TEXT,
  jf_name         TEXT,
  imported_at     INTEGER,
  indexed_at      INTEGER,
  verify_attempts INTEGER NOT NULL DEFAULT 0,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX media_items_status ON media_items(status);
CREATE INDEX media_items_torrent ON media_items(torrent_hash);

CREATE TABLE media_history (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id TEXT NOT NULL,
  ts      INTEGER NOT NULL,
  actor   TEXT NOT NULL,
  action  TEXT NOT NULL,
  details TEXT
);
CREATE INDEX media_history_item ON media_history(item_id, ts);

CREATE TABLE media_settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
