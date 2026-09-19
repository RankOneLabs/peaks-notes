import { readdir, readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { z } from "zod";
import { ClassifierPolicySchema, JournalEntrySchema } from "../schema";
import { DeterministicFixtureSchema } from "./fixture";

export const REQUIRED_CASES = [
  "equivalent_restatement",
  "shadow_bypass_substantive_patch",
  "active_sampled_bypass_substantive_patch",
  "wording_rewrite",
  "unsupported_claim",
  "dropped_qualifier",
  "comparator_inconclusive",
  "audit_inconclusive",
  "classifier_failure_shadow",
  "stable_audit_assignment",
  "qualifying_condition",
  "preference_correction",
  "unsupported_conflict",
  "brief_critical_correction",
  "low_confidence_same_info",
  "false_positive_match",
  "uncovered_useful_content",
  "two_existing_topics",
  "existing_and_new_topic",
  "transient_chatter",
  "equal_length_tool_output_change",
  "state_changing_receipt",
  "explicit_preservation",
  "replayed_chunk",
  "malformed_timeout_overlong",
  "failed_budget_reduction",
] as const;

export const RequiredCaseSchema = z.enum(REQUIRED_CASES);
export type RequiredCase = z.infer<typeof RequiredCaseSchema>;

export const FixtureLabelSchema = z
  .object({
    file: z.string().min(1),
    chunkId: z.string().min(1),
    requiredCases: z.array(RequiredCaseSchema).min(1),
    relevantTopicIds: z.array(z.string()).default([]),
    expectedRelationships: z
      .record(z.string(), z.enum(["new_info", "changing_info", "same_info"]))
      .default({}),
    requiresUpdate: z.boolean(),
    criticalUpdate: z.boolean().default(false),
    expectedNoUpdateGate: z
      .enum(["relevance", "same_info", "uncovered_content"])
      .optional(),
    protectedContent: z.array(z.string()).default([]),
    humanSpotCheck: z.boolean().default(false),
  })
  .strict();
export type FixtureLabel = z.infer<typeof FixtureLabelSchema>;

const SplitSchema = z
  .object({
    directories: z.array(z.string().min(1)).min(1),
    fixtures: z.array(FixtureLabelSchema),
  })
  .strict();

export const FixtureManifestSchema = z
  .object({
    version: z.literal(1),
    dev: SplitSchema,
    heldOut: SplitSchema,
    requiredCases: z.array(RequiredCaseSchema),
  })
  .strict()
  .superRefine((manifest, context) => {
    const declared = new Set(manifest.requiredCases);
    for (const required of REQUIRED_CASES) {
      if (!declared.has(required)) {
        context.addIssue({
          code: "custom",
          message: `missing required case: ${required}`,
        });
      }
    }
    const labeled = new Set(
      [...manifest.dev.fixtures, ...manifest.heldOut.fixtures].flatMap(
        ({ requiredCases }) => requiredCases,
      ),
    );
    for (const required of REQUIRED_CASES) {
      if (!labeled.has(required)) {
        context.addIssue({
          code: "custom",
          message: `required case has no fixture: ${required}`,
        });
      }
    }
  });
export type FixtureManifest = z.infer<typeof FixtureManifestSchema>;

export type LoadedFixture = {
  path: string;
  fixture: z.infer<typeof DeterministicFixtureSchema>;
  label: FixtureLabel;
  split: "dev" | "held_out";
};

export const loadManifest = async (
  path = "fixtures/manifest.json",
): Promise<FixtureManifest> =>
  FixtureManifestSchema.parse(JSON.parse(await readFile(path, "utf8")));

const withinDirectory = (file: string, directory: string): boolean =>
  file === directory || file.startsWith(`${directory}/`);

export const splitForDirectory = (
  manifest: FixtureManifest,
  directory: string,
): "dev" | "held_out" | undefined => {
  const normalized = directory.replace(/\/$/, "");
  if (
    manifest.heldOut.directories.some((item) =>
      withinDirectory(normalized, item),
    )
  )
    return "held_out";
  if (
    manifest.dev.directories.some((item) => withinDirectory(normalized, item))
  )
    return "dev";
  return undefined;
};

export const loadFixtures = async (
  directory: string,
  manifestPath = "fixtures/manifest.json",
): Promise<LoadedFixture[]> => {
  const manifest = await loadManifest(manifestPath);
  const split = splitForDirectory(manifest, directory);
  if (split === undefined)
    throw new Error(
      `fixture directory is not declared in ${manifestPath}: ${directory}`,
    );
  const labels =
    split === "dev" ? manifest.dev.fixtures : manifest.heldOut.fixtures;
  const byFile = new Map(labels.map((label) => [label.file, label]));
  const files = (await readdir(directory))
    .filter((file) => file.endsWith(".json"))
    .sort();
  const normalizedDirectory = directory.replace(/\/$/, "");
  const discovered = new Set(
    files.map((file) => `${normalizedDirectory}/${file}`),
  );
  const missing = labels
    .map(({ file }) => file)
    .filter(
      (file) =>
        withinDirectory(file, normalizedDirectory) && !discovered.has(file),
    );
  if (missing.length > 0)
    throw new Error(
      `manifest fixtures are missing from ${directory}: ${missing.join(", ")}`,
    );
  return Promise.all(
    files.map(async (file) => {
      const relative = `${normalizedDirectory}/${file}`;
      const label = byFile.get(relative);
      if (label === undefined)
        throw new Error(`fixture has no ${split} label: ${relative}`);
      const fixture = DeterministicFixtureSchema.parse(
        JSON.parse(await readFile(resolve(directory, file), "utf8")),
      );
      if (fixture.chunk.id !== label.chunkId)
        throw new Error(
          `manifest chunkId does not match ${basename(relative)}`,
        );
      return { path: relative, fixture, label, split };
    }),
  );
};

export const ArchivedJournalSchema = z
  .object({
    policy: ClassifierPolicySchema.optional(),
    labels: z.array(FixtureLabelSchema),
    entries: z.array(JournalEntrySchema),
  })
  .strict();
export type ArchivedJournal = z.infer<typeof ArchivedJournalSchema>;

export const loadArchivedJournal = async (
  path: string,
): Promise<ArchivedJournal> =>
  ArchivedJournalSchema.parse(JSON.parse(await readFile(path, "utf8")));
