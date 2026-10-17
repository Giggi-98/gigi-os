-- 008 — flussi di automazione con editor grafico (D-041). Le regole di notifica (002) restano separate.
CREATE TABLE workflows (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  enabled     INTEGER NOT NULL DEFAULT 0,
  graph       TEXT NOT NULL,                       -- { nodes: [...], edges: [...] }
  created_by  TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

-- Token dei webhook (solo hash) e segreti dei blocchi (cifrati con il vault), per blocco
CREATE TABLE workflow_secrets (
  workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  node_id     TEXT NOT NULL,
  token_hash  TEXT,
  secret_enc  TEXT,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (workflow_id, node_id)
);

-- Stato persistente dei blocchi: elementi già visti dai polling, doppioni, ultimo evento di prova, ultima esecuzione pianificata
CREATE TABLE workflow_state (
  workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  node_id     TEXT NOT NULL,
  key         TEXT NOT NULL,
  value       TEXT NOT NULL,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (workflow_id, node_id, key)
);

CREATE TABLE workflow_runs (
  id          TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  trigger     TEXT NOT NULL,                       -- nome del blocco di partenza
  status      TEXT NOT NULL CHECK (status IN ('running', 'waiting', 'success', 'error', 'cancelled')),
  context     TEXT NOT NULL DEFAULT '{}',          -- uscite dei blocchi per nome, usate dalle espressioni
  error       TEXT,
  started_at  INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE INDEX workflow_runs_wf ON workflow_runs (workflow_id, started_at DESC);

CREATE TABLE workflow_steps (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id      TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  node_id     TEXT NOT NULL,
  node_name   TEXT NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('ok', 'error', 'waiting', 'skipped')),
  port        TEXT,
  input       TEXT,
  output      TEXT,
  error       TEXT,
  started_at  INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE INDEX workflow_steps_run ON workflow_steps (run_id, id);

-- Attese (timer) e approvazioni in sospeso: sopravvivono ai riavvii
CREATE TABLE workflow_waits (
  id          TEXT PRIMARY KEY,
  run_id      TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  node_id     TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('timer', 'approval')),
  resume_at   INTEGER,                              -- timer: quando riprendere; approvazione: scadenza
  input       TEXT NOT NULL,
  options     TEXT,                                 -- approvazione: [{ label, value }]
  message     TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX workflow_waits_due ON workflow_waits (kind, resume_at);
