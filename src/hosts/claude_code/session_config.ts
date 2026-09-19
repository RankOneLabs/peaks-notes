import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseEnv } from "node:util";
import { type AppConfig, loadConfig } from "../../config";

const PEAKS_ENV_FILE = resolve(import.meta.dir, "../../..", ".env");

/**
 * Host processes may carry unrelated or stale model settings. The Claude host
 * always uses the configuration owned by the Peaks checkout when it exists.
 */
export const loadSessionConfig = (
  environment: Record<string, string | undefined> = process.env,
  envFile: string = PEAKS_ENV_FILE,
): AppConfig => {
  const fileEnvironment = existsSync(envFile)
    ? parseEnv(readFileSync(envFile, "utf8"))
    : {};
  return loadConfig({ ...environment, ...fileEnvironment });
};
