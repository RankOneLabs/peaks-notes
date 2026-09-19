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

/**
 * Bounds an operation and aborts its signal on expiry so the model call stops
 * spending. `beforeAbort` runs first, while adapter call state is still intact.
 */
export const withDeadline = async <T>(
  operation: (signal: AbortSignal) => Promise<T>,
  deadlineMs: number,
  beforeAbort?: () => void,
): Promise<{ status: "completed"; value: T } | { status: "timed_out" }> => {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve()
        .then(() => operation(controller.signal))
        .then((value) => ({ status: "completed" as const, value })),
      new Promise<{ status: "timed_out" }>((resolve) => {
        timer = setTimeout(() => {
          beforeAbort?.();
          controller.abort();
          resolve({ status: "timed_out" });
        }, deadlineMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};
