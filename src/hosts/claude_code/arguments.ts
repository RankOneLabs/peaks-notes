import { z } from "zod";

/** Session IDs become file names, so only path-safe characters pass. */
export const SessionIdSchema = z.string().regex(/^[A-Za-z0-9_-]+$/);

/** `--key value` pairs; each entry point validates them with its own schema. */
export const flagValues = (args: string[]): Record<string, string> => {
  const values: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (flag === undefined || !flag.startsWith("--") || value === undefined)
      throw new Error(`expected --flag value pairs, got: ${args.join(" ")}`);
    values[flag.slice(2)] = value;
  }
  return values;
};
