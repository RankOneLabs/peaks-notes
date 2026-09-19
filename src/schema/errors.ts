import { z } from "zod";

export const DomainErrorSchema = z.discriminatedUnion("code", [
  z
    .object({
      code: z.literal("storage_error"),
      message: z.string(),
      operation: z.string(),
    })
    .strict(),
  z
    .object({
      code: z.literal("stale_revision"),
      message: z.string(),
      expectedRevision: z.number().int().nonnegative(),
      actualRevision: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      code: z.literal("validation_error"),
      message: z.string(),
      issues: z.array(z.string()),
    })
    .strict(),
  z
    .object({
      code: z.literal("not_found"),
      message: z.string(),
      resource: z.string(),
    })
    .strict(),
]);

export type DomainError = z.infer<typeof DomainErrorSchema>;
