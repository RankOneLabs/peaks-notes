import { z } from "zod";

/** Spec §5 execution modes: shadow by default, with deterministic active audits. */
export const ExecutionPolicySchema = z
  .object({
    mode: z.enum(["shadow", "active"]).default("shadow"),
    bypassAuditRate: z.number().min(0).max(1),
    auditSeed: z.string(),
  })
  .strict();
export type ExecutionPolicy = z.infer<typeof ExecutionPolicySchema>;

/** Spec §6 prose: a host-supplied token allowance for rendered memory. */
export const TokenBudgetSchema = z
  .object({
    maxTokens: z.number().int().positive(),
    warningThreshold: z.number().min(0).max(1).default(0.8),
  })
  .strict();
export type TokenBudget = z.infer<typeof TokenBudgetSchema>;

export const TokenCountSchema = z
  .object({
    tokens: z.number().int().nonnegative(),
    method: z.enum(["target_tokenizer", "conservative_estimate"]),
  })
  .strict();
export type TokenCount = z.infer<typeof TokenCountSchema>;

/** Spec §6 prose: target-tokenizer abstraction used for the entire rendered output. */
export interface Tokenizer {
  count(text: string): TokenCount;
}
