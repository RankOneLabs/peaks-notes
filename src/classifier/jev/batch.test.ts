import { expect, test } from "bun:test";
import { batchJevQuestions, IncompleteInputError } from "./batch";

test("splits large question catalogs without omitting a topic", () => {
  const questions = Object.fromEntries(
    Array.from({ length: 8 }, (_, index) => [
      `topic-${index}`,
      {
        type: "noul" as const,
        instructions: `Question ${index} ${"x".repeat(300)}`,
      },
    ]),
  );
  const batches = batchJevQuestions("small chunk", questions, 450, 1000);
  expect(batches.length).toBeGreaterThan(1);
  expect(
    batches.flatMap((batch) => Object.keys(batch.questions)).sort(),
  ).toEqual(Object.keys(questions).sort());
});

test("chunk/state that cannot fit yields typed incomplete_input", () => {
  try {
    batchJevQuestions(
      "x".repeat(1000),
      { q: { type: "noul", instructions: "yes?" } },
      10,
    );
    throw new Error("expected rejection");
  } catch (error) {
    expect(error).toBeInstanceOf(IncompleteInputError);
    expect((error as IncompleteInputError).code).toBe("incomplete_input");
  }
});
