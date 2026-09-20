import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConfiguredAdapters } from "../../adapters";
import { SqliteStore } from "../../store/sqlite";
import { loadSessionConfig } from "./session_config";
import { sessionDependencies } from "./worker";

let directory: string | undefined;
afterEach(() => {
  if (directory !== undefined) rmSync(directory, { recursive: true });
  directory = undefined;
});

test("the Peaks env file overrides stale host model settings", () => {
  directory = mkdtempSync(join(tmpdir(), "peaks-session-config-"));
  const envFile = join(directory, ".env");
  writeFileSync(envFile, "WRITER_DEADLINE_MS=120000\n");

  const config = loadSessionConfig(
    {
      WRITER_PROVIDER: "openrouter",
      WRITER_MODEL: "model",
      OPENROUTER_API_KEY: "writer-key",
      JEV_BEARER_KEY: "jev-key",
      WRITER_DEADLINE_MS: "30000",
    },
    envFile,
  );

  expect(config.writer.deadlineMs).toBe(120_000);

  const store = new SqliteStore(":memory:");
  try {
    const dependencies = sessionDependencies(
      "session",
      store,
      config,
      createConfiguredAdapters(config),
    );
    expect(dependencies.writerDeadlineMs).toBe(120_000);
  } finally {
    store.close();
  }
});
