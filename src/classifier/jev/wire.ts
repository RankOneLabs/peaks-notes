import { z } from "zod";

export const JEV_MODEL = "jev-1.13.0" as const;

export const JevNoulQuestionSchema = z
  .object({
    type: z.literal("noul"),
    instructions: z.string().min(1),
    criteria: z
      .object({ true: z.string().min(1), false: z.string().min(1) })
      .strict()
      .optional(),
  })
  .strict();

export const JevChoiceQuestionSchema = z
  .object({
    type: z.literal("choice"),
    instructions: z.string().min(1),
    criteria: z
      .record(z.string().min(1), z.string().min(1))
      .refine((criteria) => Object.keys(criteria).length >= 2, {
        message: "choice requires at least two criteria",
      }),
  })
  .strict();

export const JevQuestionSchema = z.discriminatedUnion("type", [
  JevNoulQuestionSchema,
  JevChoiceQuestionSchema,
]);
export type JevQuestion = z.infer<typeof JevQuestionSchema>;

export const JevRequestSchema = z
  .object({
    model: z.literal(JEV_MODEL),
    state: z.string(),
    questions: z.record(z.string().min(1), JevQuestionSchema),
  })
  .strict();
export type JevRequest = z.infer<typeof JevRequestSchema>;

export const JevNoulAnswerSchema = z
  .object({
    type: z.literal("noul"),
    noul: z.number().min(0).max(1),
  })
  .strict();

export const JevChoiceAnswerSchema = z
  .object({
    type: z.literal("choice"),
    choice: z.string().min(1),
    probabilities: z.record(z.string().min(1), z.number().min(0).max(1)),
    confidence: z.number().min(0).max(1),
  })
  .strict();

export const JevAnswerSchema = z.discriminatedUnion("type", [
  JevNoulAnswerSchema,
  JevChoiceAnswerSchema,
]);
export type JevAnswer = z.infer<typeof JevAnswerSchema>;

export const JevResponseSchema = z
  .object({
    model: z.string().min(1).optional(),
    answers: z.record(z.string().min(1), JevAnswerSchema),
    usage: z
      .object({
        input_tokens: z.number().int().nonnegative(),
        output_tokens: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();
export type JevResponse = z.infer<typeof JevResponseSchema>;

export const parseJevResponse = (
  value: unknown,
  request: JevRequest,
): JevResponse => {
  const response = JevResponseSchema.parse(value);
  for (const [id, question] of Object.entries(request.questions)) {
    const answer = response.answers[id];
    if (answer === undefined) throw new Error(`missing question id: ${id}`);
    if (answer.type !== question.type)
      throw new Error(`answer type mismatch for question id: ${id}`);
    if (answer.type === "choice" && question.type === "choice") {
      const allowed = new Set(Object.keys(question.criteria));
      if (!allowed.has(answer.choice))
        throw new Error(`choice outside criteria for question id: ${id}`);
      if (
        Object.keys(answer.probabilities).some((choice) => !allowed.has(choice)) ||
        [...allowed].some((choice) => answer.probabilities[choice] === undefined)
      ) {
        throw new Error(`invalid probability distribution for question id: ${id}`);
      }
    }
  }
  for (const id of Object.keys(response.answers)) {
    if (request.questions[id] === undefined)
      throw new Error(`unknown question id: ${id}`);
  }
  return response;
};
