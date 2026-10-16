-- 006 — account Telegram collegati agli utenti GIGI OS (D-031). Il bot applica il ruolo dell'utente collegato.
CREATE TABLE telegram_links (
  tg_user_id   TEXT PRIMARY KEY,                                         -- id dell'account Telegram (from.id)
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  chat_id      TEXT NOT NULL,                                            -- chat privata con il bot
  tg_name      TEXT,
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER
);
CREATE INDEX telegram_links_user ON telegram_links (user_id);
