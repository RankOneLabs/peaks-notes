import { z } from "zod";

/** Spec §6 public render result; over-budget content is never silently clipped. */
export const RenderResultSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("rendered"),
      content: z.string(),
      tokens: z.number().int().nonnegative(),
      warning: z.boolean(),
    })
    .strict(),
  z
    .object({
      status: z.literal("budget_exceeded"),
      budget: z.number().int().positive(),
      required: z.number().int().nonnegative(),
    })
    .strict(),
]);
export type RenderResult = z.infer<typeof RenderResultSchema>;
