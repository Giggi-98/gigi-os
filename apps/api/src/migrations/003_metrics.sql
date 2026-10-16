-- Storico delle metriche (D-027): host al minuto, container a 5 minuti, dischi all'ora. Retention in metrics.ts.
CREATE TABLE metrics_host (
  t INTEGER PRIMARY KEY,        -- inizio del minuto (ms)
  cpu REAL NOT NULL,            -- media del minuto (%)
  cpu_max REAL NOT NULL,        -- picco del minuto (%)
  mem REAL NOT NULL,            -- RAM usata (%)
  rx REAL NOT NULL,             -- byte/s medi in ricezione
  tx REAL NOT NULL,             -- byte/s medi in trasmissione
  load1 REAL NOT NULL,
  temp REAL,                    -- °C, NULL se nessun sensore
  n INTEGER NOT NULL            -- campioni aggregati
);

CREATE TABLE metrics_container (
  t INTEGER NOT NULL,           -- inizio dei 5 minuti (ms)
  name TEXT NOT NULL,
  cpu_sum REAL NOT NULL,        -- somma dei campioni CPU (%), media = cpu_sum / n
  mem_sum REAL NOT NULL,        -- somma dei campioni RAM (byte)
  mem_max REAL NOT NULL,
  n INTEGER NOT NULL,
  PRIMARY KEY (t, name)
) WITHOUT ROWID;

CREATE TABLE metrics_disk (
  t INTEGER NOT NULL,           -- inizio dell'ora (ms), ultimo valore letto nell'ora
  label TEXT NOT NULL,
  used INTEGER NOT NULL,
  free INTEGER NOT NULL,        -- spazio disponibile (bavail)
  total INTEGER NOT NULL,
  PRIMARY KEY (label, t)
) WITHOUT ROWID;

CREATE INDEX metrics_disk_t ON metrics_disk (t);
