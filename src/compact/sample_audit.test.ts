import { expect, test } from "bun:test";
import { auditSampleValue, sampleAudit } from "./sample_audit";

test("sampling is stable for a chunk and seed", () => {
  expect(auditSampleValue("chunk", "seed")).toBe(
    auditSampleValue("chunk", "seed"),
  );
  expect(sampleAudit("chunk", "seed", 1)).toBe(true);
  expect(sampleAudit("chunk", "seed", 0)).toBe(false);
});

test("a different seed changes at least one assignment", () => {
  const ids = Array.from({ length: 64 }, (_, index) => `chunk-${index}`);
  expect(
    ids.some((id) => sampleAudit(id, "a", 0.5) !== sampleAudit(id, "b", 0.5)),
  ).toBe(true);
});

test("the sampled fraction tracks the configured rate", () => {
  const ids = Array.from({ length: 4_000 }, (_, index) => `chunk-${index}`);
  for (const rate of [0.1, 0.5]) {
    const sampled = ids.filter((id) => sampleAudit(id, "seed", rate)).length;
    expect(Math.abs(sampled / ids.length - rate)).toBeLessThan(0.03);
  }
});
