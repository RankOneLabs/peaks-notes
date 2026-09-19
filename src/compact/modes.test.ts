import { expect, test } from "bun:test";
import type { RoutingDecision } from "./decide_routing";
import { modeAction, withDeadline } from "./modes";

test("shadow and baseline always invoke writer while active honors bypass", () => {
  const bypass: RoutingDecision = {
    kind: "bypass",
    affectedTopicIds: [],
    reason: "same",
  };
  expect(modeAction("shadow", bypass)).toBe("writer");
  expect(modeAction("baseline", bypass)).toBe("writer");
  expect(modeAction("active", bypass)).toBe("bypass");
});

test("audit work has a bounded deadline", async () => {
  expect(await withDeadline(new Promise(() => {}), 1)).toEqual({
    status: "timed_out",
  });
});
