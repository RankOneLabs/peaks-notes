import type { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { emptyMemory } from "../schema/memory";

export type Migration = {
  version: number;
  sql: string;
};

const initialSchema = readFileSync(
  new URL("./schema.sql", import.meta.url),
  "utf8",
);

export const migrations: readonly Migration[] = [
  {
    version: 1,
    sql: initialSchema,
  },
] as const;

export const migrate = (database: Database): void => {
  database.exec("PRAGMA foreign_keys = ON;");
  database.exec("PRAGMA journal_mode = WAL;");
  const hasMigrationTable =
    database
      .query<{ present: number }, []>(
        "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'",
      )
      .get() !== null;
  const applied = hasMigrationTable
    ? database
        .query<{ version: number }, []>("SELECT version FROM schema_migrations")
        .all()
        .map(({ version }) => version)
    : [];

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
