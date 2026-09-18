import { expect, test } from "bun:test";
import { estimateTokens } from "./estimate_tokens";

test("the fallback estimator has a measured conservative bias on a reference sample", () => {
  const samples = [
    { text: "hello world", reference: 2 },
    { text: "IDs: A-007 /var/app/config.json", reference: 9 },
    { text: "部署完成", reference: 4 },
  ];
  const biases = samples.map(({ text, reference }) => estimateTokens(text) - reference);
  const meanBias = biases.reduce((sum, value) => sum + value, 0) / biases.length;
  expect(meanBias).toBeGreaterThanOrEqual(0);
  expect(Math.min(...biases)).toBeGreaterThanOrEqual(0);
});
