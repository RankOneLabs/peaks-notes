import { expect, test } from "bun:test";
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
