import type { Database } from "bun:sqlite";
import { emptyMemory } from "../schema/memory";

export type Migration = {
  version: number;
  sql: string;
};

export const migrations: readonly Migration[] = [
  {
    version: 1,
    sql: `
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
    `,
  },
] as const;

export const migrate = (database: Database): void => {
  database.exec("PRAGMA foreign_keys = ON;");
  database.exec("PRAGMA journal_mode = WAL;");
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);

  const applied = database
    .query<{ version: number }, []>("SELECT version FROM schema_migrations")
    .all()
    .map(({ version }) => version);

  for (const migration of migrations) {
    if (!applied.includes(migration.version)) {
      database.transaction(() => {
        database.exec(migration.sql);
        database
          .query(
            "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)",
          )
          .run(migration.version, new Date().toISOString());
      })();
    }
  }

  database
    .query(
      "INSERT OR IGNORE INTO memory_state (singleton, revision, document) VALUES (1, 0, ?)",
    )
    .run(JSON.stringify(emptyMemory()));
};
