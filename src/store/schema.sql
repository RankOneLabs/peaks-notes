PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS memory_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  revision INTEGER NOT NULL CHECK (revision >= 0),
  document TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS chunk_archive (
  chunk_id TEXT PRIMARY KEY,
  archived_at TEXT NOT NULL,
  document TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS journal (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_id TEXT NOT NULL UNIQUE,
  entry_type TEXT NOT NULL,
  chunk_id TEXT NOT NULL,
  snapshot_revision INTEGER NOT NULL,
  occurred_at TEXT NOT NULL,
  document TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS processed_chunks (
  chunk_id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL,
  processed_at TEXT NOT NULL
);
