import type { RoutingDecision } from "./decide_routing";

export type PipelineMode = "shadow" | "active" | "baseline";
export type ModeAction = "writer" | "bypass";

/** Pure execution-mode policy. Shadow and baseline always consult the writer. */
export const modeAction = (
  mode: PipelineMode,
  routing: RoutingDecision | undefined,
): ModeAction =>
  mode === "active" && routing?.kind === "bypass" ? "bypass" : "writer";

export const DEFAULT_AUDIT_DEADLINE_MS = 2_000;
export const DEFAULT_SHADOW_COMPARISON_DEADLINE_MS = 2_000;
export const DEFAULT_WRITER_DEADLINE_MS = 30_000;

export const withDeadline = async <T>(
  operation: Promise<T>,
  deadlineMs: number,
): Promise<{ status: "completed"; value: T } | { status: "timed_out" }> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation.then((value) => ({ status: "completed" as const, value })),
      new Promise<{ status: "timed_out" }>((resolve) => {
        timer = setTimeout(() => resolve({ status: "timed_out" }), deadlineMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};
