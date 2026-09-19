import { expect, test } from "bun:test";
import type { Chunk, Memory } from "../schema";
import { validatePatch } from "./validate_patch";

const memory = {
  revision: 1,
  topics: [
    {
      id: "topic-1",
      title: "A",
      description: "A",
      version: 1,
      summary: "A",
      sources: [],
      unresolved: [],
    },
  ],
  protected: [],
  processedChunkIds: [],
} as unknown as Memory;
const chunk = {
  id: "chunk-1",
  createdAt: "2026-09-18T00:00:00.000Z",
  messages: [{ id: "message-1", role: "user", content: "B" }],
} as Chunk;

test("rejects unknown topic ids and source ids", () => {
  const base = { newTopics: [], addProtected: [], supersedeProtected: [] };
  expect(
    validatePatch(memory, chunk, {
      ...base,
      replacements: [
        {
          topicId: "missing",
          expectedVersion: 1,
          title: "A",
          description: "A",
          summary: "B",
          sources: [],
          unresolved: [],
        },
      ],
    }).ok,
  ).toBe(false);
  expect(
    validatePatch(memory, chunk, {
      ...base,
      replacements: [
        {
          topicId: "topic-1",
          expectedVersion: 1,
          title: "A",
          description: "A",
          summary: "B",
          sources: [{ messageId: "missing" }],
          unresolved: [],
        },
      ],
    }).ok,
  ).toBe(false);
});

const protectedMemory = {
  ...memory,
  protected: [
    {
      id: "pin-1",
      kind: "explicit_pin",
      text: "keep",
      sources: [],
      status: "active",
    },
    {
      id: "receipt-1",
      kind: "action_receipt",
      text: "receipt",
      sources: [],
      status: "active",
    },
  ],
} as unknown as Memory;

const emptyPatch = {
  replacements: [],
  newTopics: [],
  addProtected: [],
  supersedeProtected: [],
};

test("rejects duplicate protected ids within one patch", () => {
  const record = {
    id: "new-protected",
    kind: "constraint" as const,
    text: "constraint",
    sources: [{ messageId: "message-1" }],
    status: "active" as const,
  };
  expect(
    validatePatch(memory, chunk, {
      ...emptyPatch,
      addProtected: [record, record],
    }).ok,
  ).toBe(false);
});

test("rejects self-supersession and superseding active receipts", () => {
  expect(
    validatePatch(protectedMemory, chunk, {
      ...emptyPatch,
      supersedeProtected: [{ id: "pin-1", supersededBy: "pin-1" }],
    }).ok,
  ).toBe(false);
  expect(
    validatePatch(protectedMemory, chunk, {
      ...emptyPatch,
      addProtected: [
        {
          id: "replacement",
          kind: "constraint",
          text: "replacement",
          sources: [{ messageId: "message-1" }],
          status: "active",
        },
      ],
      supersedeProtected: [{ id: "receipt-1", supersededBy: "replacement" }],
    }).ok,
  ).toBe(false);
});
