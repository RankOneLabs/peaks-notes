import { expect, test } from "bun:test";
import { parseSemanticComparison } from "./parse";

test("material changes require sources and evidence", () => {
  expect(() =>
    parseSemanticComparison(
      JSON.stringify({
        verdict: "material_change",
        changes: [
          {
            kind: "addition",
            before: null,
            after: "fact",
            sources: [],
            assessment: "required_update",
            reason: "new",
          },
        ],
      }),
    ),
  ).toThrow("requires source refs");
});

test("parses evidenced material changes", () => {
  expect(
    parseSemanticComparison(
      JSON.stringify({
        verdict: "material_change",
        changes: [
          {
            kind: "correction",
            before: "old",
            after: "new",
            sources: [{ messageId: "message-1" }],
            assessment: "required_update",
            reason: "source correction",
          },
        ],
      }),
    ).verdict,
  ).toBe("material_change");
});
