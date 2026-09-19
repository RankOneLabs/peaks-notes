import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { valueAfter } from "./cli";
import { loadFixtures } from "./load_fixtures";
import { assertExpected, runReplay } from "./run";

test("stub replay runs deterministic fixtures without protected or critical losses", async () => {
  const result = await runReplay({
    fixtures: "fixtures/deterministic",
    adapters: "stub",
  });
  expect(result.fixtures).toHaveLength(15);
  expect(result.metrics.protectedContentLosses).toBe(0);
  expect(result.metrics.missedCriticalUpdates).toBe(0);
});

test("replay validates every populated fixture expectation", async () => {
  const loaded = (await loadFixtures("fixtures/semantic")).find(
    ({ fixture }) => fixture.chunk.id === "chunk-equivalent",
  );
  const replay = (
    await runReplay({ fixtures: "fixtures/semantic", adapters: "stub" })
  ).fixtures.find(({ result }) => result.chunkId === "chunk-equivalent");
  if (loaded === undefined || replay === undefined)
    throw new Error("equivalent fixture was not loaded");

  expect(() =>
    assertExpected(
      {
        ...loaded,
        fixture: {
          ...loaded.fixture,
          expected: { ...loaded.fixture.expected, revision: 999 },
        },
      },
      replay,
    ),
  ).toThrow("expected revision=999");
  expect(() =>
    assertExpected(
      {
        ...loaded,
        fixture: {
          ...loaded.fixture,
          expected: {
            ...loaded.fixture.expected,
            reasonIncludes: "missing reason",
          },
        },
      },
      replay,
    ),
  ).toThrow("expected reason containing");
  expect(() =>
    assertExpected(
      {
        ...loaded,
        fixture: {
          ...loaded.fixture,
          expected: { ...loaded.fixture.expected, auditOutcome: "failed" },
        },
      },
      replay,
    ),
  ).toThrow("expected audit outcome=failed");
});

test("a shadow writer rescue remains a classifier-policy miss", async () => {
  const result = await runReplay({
    fixtures: "fixtures/semantic",
    adapters: "stub",
  });
  expect(
    result.metrics.classifierPolicy?.requiredUpdatesPredictedBypass,
  ).toBeGreaterThanOrEqual(1);
  expect(
    result.metrics.classifierPolicy?.criticalMisses,
  ).toBeGreaterThanOrEqual(1);
  expect(result.metrics.authoritative?.committedUpdates).toBeGreaterThan(0);
});

test("fixture loading rejects manifest entries missing from the directory", async () => {
  const directory = await mkdtemp(join(tmpdir(), "peaks-missing-fixture-"));
  const manifestPath = join(directory, "manifest.json");
  try {
    const manifest = JSON.parse(
      await readFile("fixtures/manifest.json", "utf8"),
    );
    manifest.dev.fixtures.push({
      file: "fixtures/deterministic/missing-declared.json",
      chunkId: "chunk-missing-declared",
      requiredCases: ["replayed_chunk"],
      requiresUpdate: false,
    });
    await writeFile(manifestPath, JSON.stringify(manifest), "utf8");
    await expect(
      loadFixtures("fixtures/deterministic", manifestPath),
    ).rejects.toThrow("missing-declared.json");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("fixture loading rejects duplicate chunkId within a directory", async () => {
  const directory = await mkdtemp(join(tmpdir(), "peaks-duplicate-chunk-"));
  try {
    const fixturesDir = join(directory, "fixtures");
    await mkdir(fixturesDir);
    const fixtureContent = await readFile(
      "fixtures/deterministic/audit-timeout.json",
      "utf8",
    );
    await writeFile(join(fixturesDir, "a.json"), fixtureContent, "utf8");
    await writeFile(join(fixturesDir, "b.json"), fixtureContent, "utf8");

    const manifest = JSON.parse(
      await readFile("fixtures/manifest.json", "utf8"),
    );
    manifest.dev.directories.push(fixturesDir);
    const label = {
      file: "",
      chunkId: "chunk-audit-timeout",
      requiredCases: ["audit_inconclusive"],
      requiresUpdate: false,
    };
    manifest.dev.fixtures.push(
      { ...label, file: `${fixturesDir}/a.json` },
      { ...label, file: `${fixturesDir}/b.json` },
    );
    const manifestPath = join(directory, "manifest.json");
    await writeFile(manifestPath, JSON.stringify(manifest), "utf8");

    await expect(loadFixtures(fixturesDir, manifestPath)).rejects.toThrow(
      "duplicate chunkId chunk-audit-timeout",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("CLI flags reject missing values", () => {
  expect(() => valueAfter(["--adapters"], "--adapters")).toThrow(
    "--adapters requires a value",
  );
  expect(() =>
    valueAfter(["--adapters", "--mode", "active"], "--adapters"),
  ).toThrow("--adapters requires a value");
});

test("recorded audit assignments override resampling", async () => {
  const result = await runReplay({
    fixtures: "fixtures/deterministic",
    adapters: "recorded",
    recordedAuditAssignments: new Map([["chunk-sampled", false]]),
  });
  expect(result.auditAssignments["chunk-sampled"]).toBe(false);
});

test("explicit active mode requires a sweep record", async () => {
  await expect(
    runReplay({
      fixtures: "fixtures/deterministic",
      adapters: "stub",
      mode: "active",
      sweepRecordPath: "/tmp/peaks-missing-sweep-record.json",
    }),
  ).rejects.toThrow("active mode requires");
});

test("mode active asserts an active-authored fixture and fails on a wrong stub outcome", async () => {
  const directory = await mkdtemp(join(tmpdir(), "peaks-active-mismatch-"));
  try {
    const fixturesDir = join(directory, "fixtures");
    await mkdir(fixturesDir);
    const fixtureContent = JSON.parse(
      await readFile(
        "fixtures/deterministic/same-seed-audit-assignment.json",
        "utf8",
      ),
    );
    fixtureContent.expected = {
      ...fixtureContent.expected,
      status: "committed",
    };
    await writeFile(
      join(fixturesDir, "same-seed-audit-assignment.json"),
      JSON.stringify(fixtureContent),
      "utf8",
    );

    const sweepRecordPath = join(directory, "sweep-record.json");
    await writeFile(
      sweepRecordPath,
      JSON.stringify({
        version: 2,
        split: "dev",
        chosenPolicy: fixtureContent.classifierPolicy,
      }),
      "utf8",
    );

    const manifest = JSON.parse(
      await readFile("fixtures/manifest.json", "utf8"),
    );
    manifest.dev.directories.push(fixturesDir);
    manifest.dev.fixtures.push({
      file: `${fixturesDir}/same-seed-audit-assignment.json`,
      chunkId: "chunk-sampled",
      requiredCases: ["stable_audit_assignment"],
      relevantTopicIds: ["topic-1"],
      expectedRelationships: { "topic-1": "same_info" },
      requiresUpdate: false,
    });
    const manifestPath = join(directory, "manifest.json");
    await writeFile(manifestPath, JSON.stringify(manifest), "utf8");

    await expect(
      runReplay({
        fixtures: fixturesDir,
        adapters: "stub",
        mode: "active",
        manifestPath,
        sweepRecordPath,
      }),
    ).rejects.toThrow("expected committed, received no_update");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("archived journal replay loads labels, entries, and recorded assignments", async () => {
  const directory = await mkdtemp(join(tmpdir(), "peaks-journal-replay-"));
  const path = join(directory, "journal.json");
  try {
    await writeFile(
      path,
      JSON.stringify({
        policy: {
          relevanceThreshold: 0.5,
          sameInfoMinConfidence: 0.8,
          uncoveredNoChangeMinConfidence: 0.8,
        },
        labels: [
          {
            file: "archive/fixture.json",
            chunkId: "chunk-archived",
            requiredCases: ["stable_audit_assignment"],
            requiresUpdate: false,
          },
        ],
        entries: [
          {
            type: "audit_record",
            id: "journal-archived-audit",
            occurredAt: "2026-09-18T00:00:00.000Z",
            chunkId: "chunk-archived",
            snapshotRevision: 1,
            policy: {
              mode: "active",
              bypassAuditRate: 0.25,
              auditSeed: "archive-seed",
            },
            sampled: true,
            proposedBypass: true,
            outcome: "empty_patch",
          },
        ],
      }),
      "utf8",
    );
    const replay = await runReplay({ journal: path, adapters: "recorded" });
    expect(replay.auditAssignments["chunk-archived"]).toBe(true);
    expect(replay.metrics).toMatchObject({
      fixtures: 1,
      audits: { eligible: 1, sampled: 1, completed: 1 },
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
