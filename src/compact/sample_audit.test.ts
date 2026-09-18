import { expect, test } from "bun:test";
import { auditSampleValue, sampleAudit } from "./sample_audit";

test("sampling is stable for a chunk and seed", () => {
  expect(auditSampleValue("chunk", "seed")).toBe(auditSampleValue("chunk", "seed"));
  expect(sampleAudit("chunk", "seed", 1)).toBe(true);
  expect(sampleAudit("chunk", "seed", 0)).toBe(false);
});

test("a different seed changes at least one assignment", () => {
  const ids = Array.from({ length: 64 }, (_, index) => `chunk-${index}`);
  expect(ids.some((id) => sampleAudit(id, "a", 0.5) !== sampleAudit(id, "b", 0.5))).toBe(true);
});
