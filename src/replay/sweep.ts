import { writeFile } from "node:fs/promises";
import { z } from "zod";
import { ClassifierPolicySchema, type ClassifierPolicy } from "../schema";
import { loadManifest, splitForDirectory } from "./load_fixtures";
import type { MetricsReport } from "./metrics";
import { runReplay, type ReplayAdapterMode } from "./run";

export const ThresholdGridSchema = z
  .object({
    relevanceThreshold: z.array(z.number().finite()).min(1),
    sameInfoMinConfidence: z.array(z.number().finite()).min(1),
    uncoveredNoChangeMinConfidence: z.array(z.number().finite()).min(1),
  })
  .strict();
export type ThresholdGrid = z.infer<typeof ThresholdGridSchema>;

export const DEFAULT_THRESHOLD_GRID: ThresholdGrid = {
  relevanceThreshold: [0.3, 0.5, 0.7],
  sameInfoMinConfidence: [0.7, 0.8, 0.9],
  uncoveredNoChangeMinConfidence: [0.7, 0.8, 0.9],
};

export const SweepRecordSchema = z
  .object({
    version: z.literal(1),
    createdAt: z.string().datetime(),
    fixtureDirectory: z.string(),
    split: z.literal("dev"),
    adapters: z.enum(["stub", "recorded", "live"]),
    chosenPolicy: ClassifierPolicySchema,
    candidatesEvaluated: z.number().int().positive(),
  })
  .strict();
export type SweepRecord = z.infer<typeof SweepRecordSchema>;

export type SweepCandidate = { policy: ClassifierPolicy; metrics: MetricsReport };

export const enumeratePolicies = (grid: ThresholdGrid): ClassifierPolicy[] => {
  const parsed = ThresholdGridSchema.parse(grid);
  const policies: ClassifierPolicy[] = [];
  for (const relevanceThreshold of parsed.relevanceThreshold)
    for (const sameInfoMinConfidence of parsed.sameInfoMinConfidence)
      for (const uncoveredNoChangeMinConfidence of parsed.uncoveredNoChangeMinConfidence)
        policies.push({
          relevanceThreshold,
          sameInfoMinConfidence,
          uncoveredNoChangeMinConfidence,
        });
  return policies;
};

const numberOrWorst = (value: number | null, worst: number): number => value ?? worst;

/** Lower risk wins, followed by recall, precision, then potential savings. */
export const choosePolicy = (candidates: readonly SweepCandidate[]): SweepCandidate => {
  const sorted = [...candidates].sort((left, right) => {
    const comparisons = [
      left.metrics.missedCriticalUpdates - right.metrics.missedCriticalUpdates,
      left.metrics.protectedContentLosses - right.metrics.protectedContentLosses,
      left.metrics.falseNoUpdates.count - right.metrics.falseNoUpdates.count,
      numberOrWorst(right.metrics.relevance.recall, -1) -
        numberOrWorst(left.metrics.relevance.recall, -1),
      numberOrWorst(right.metrics.relevance.precision, -1) -
        numberOrWorst(left.metrics.relevance.precision, -1),
      right.metrics.savings.potentialWriterCallsShadow -
        left.metrics.savings.potentialWriterCallsShadow,
      left.policy.relevanceThreshold - right.policy.relevanceThreshold,
      right.policy.sameInfoMinConfidence - left.policy.sameInfoMinConfidence,
      right.policy.uncoveredNoChangeMinConfidence -
        left.policy.uncoveredNoChangeMinConfidence,
    ];
    return comparisons.find((value) => value !== 0) ?? 0;
  });
  const chosen = sorted[0];
  if (chosen === undefined) throw new Error("threshold sweep produced no candidates");
  return chosen;
};

export const assertDevelopmentFixtures = async (
  fixtureDirectory: string,
  manifestPath = "fixtures/manifest.json",
): Promise<void> => {
  const manifest = await loadManifest(manifestPath);
  const split = splitForDirectory(manifest, fixtureDirectory);
  if (split === "held_out")
    throw new Error(`threshold tuning refuses held-out fixtures: ${fixtureDirectory}`);
  if (split !== "dev")
    throw new Error(`threshold tuning requires a declared dev directory: ${fixtureDirectory}`);
};

export type RunSweepOptions = {
  fixtures: string;
  manifestPath?: string;
  adapters?: ReplayAdapterMode;
  grid?: ThresholdGrid;
  recordPath?: string;
};

export const runSweep = async (
  options: RunSweepOptions,
): Promise<{ record: SweepRecord; candidates: SweepCandidate[] }> => {
  await assertDevelopmentFixtures(options.fixtures, options.manifestPath);
  const adapters = options.adapters ?? "stub";
  const candidates: SweepCandidate[] = [];
  for (const policy of enumeratePolicies(options.grid ?? DEFAULT_THRESHOLD_GRID)) {
    const replay = await runReplay({
      fixtures: options.fixtures,
      ...(options.manifestPath === undefined ? {} : { manifestPath: options.manifestPath }),
      adapters,
      policy,
    });
    candidates.push({ policy, metrics: replay.metrics });
  }
  const chosen = choosePolicy(candidates);
  const record: SweepRecord = {
    version: 1,
    createdAt: new Date().toISOString(),
    fixtureDirectory: options.fixtures,
    split: "dev",
    adapters,
    chosenPolicy: chosen.policy,
    candidatesEvaluated: candidates.length,
  };
  if (options.recordPath !== undefined)
    await writeFile(options.recordPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  return { record, candidates };
};
