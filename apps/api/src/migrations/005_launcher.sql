-- 005 — launcher delle app (D-030): lista condivisa gestita dagli admin.
CREATE TABLE launcher_apps (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  url            TEXT NOT NULL,
  grp            TEXT NOT NULL DEFAULT '',
  color          TEXT NOT NULL DEFAULT 'chart-1',
  position       INTEGER NOT NULL DEFAULT 0,
  container      TEXT,                                   -- stato dal container, se collegato
  integration_id TEXT REFERENCES integrations(id) ON DELETE SET NULL,
  icon_type      TEXT,                                   -- favicon dell'app, scaricata dal server e servita da GIGI OS
  icon_data      BLOB,
  status         TEXT,                                   -- ultimo controllo HTTP: online / offline / unknown
  status_at      INTEGER,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
CREATE INDEX launcher_apps_position ON launcher_apps (position);
