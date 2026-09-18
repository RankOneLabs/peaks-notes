import { z } from "zod";

/** Spec §§3, 5 and 6 prose: policy context kept separate from transcript data. */
export const TaskContextSchema = z
  .object({
    currentTask: z.string(),
    compactionInstructions: z.array(z.string()),
  })
  .strict();
export type TaskContext = z.infer<typeof TaskContextSchema>;
