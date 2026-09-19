import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runReplay } from "./run";

test("stub replay runs deterministic fixtures without protected or critical losses", async () => {
  const result = await runReplay({
    fixtures: "fixtures/deterministic",
    adapters: "stub",
  });
  expect(result.fixtures).toHaveLength(15);
  expect(result.metrics.protectedContentLosses).toBe(0);
  expect(result.metrics.missedCriticalUpdates).toBe(0);
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
