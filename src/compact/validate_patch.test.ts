import { expect, test } from "bun:test";
import type { Chunk, Memory } from "../schema";
import { validateCompressionPatch, validatePatch } from "./validate_patch";

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
  messages: [
    { id: "message-1", role: "user", content: "never deploy on Friday" },
  ],
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
    text: "never deploy",
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
          text: "never deploy",
          sources: [{ messageId: "message-1" }],
          status: "active",
        },
      ],
      supersedeProtected: [{ id: "receipt-1", supersededBy: "replacement" }],
    }).ok,
  ).toBe(false);
});

const writerRecord = {
  id: "new-protected",
  kind: "constraint",
  text: "never deploy",
  sources: [{ messageId: "message-1" }],
  status: "active",
};
const withRecord = (record: object) =>
  validatePatch(memory, chunk, { ...emptyPatch, addProtected: [record] });

test("writer protected records must be verbatim chunk text", () => {
  expect(withRecord(writerRecord).ok).toBe(true);
  expect(
    withRecord({
      ...writerRecord,
      sources: [{ messageId: "message-1", start: 0, end: 12 }],
    }).ok,
  ).toBe(true);
  for (const record of [
    { ...writerRecord, text: "Never deploy" },
    { ...writerRecord, text: "always deploy on Friday" },
    { ...writerRecord, text: "" },
    { ...writerRecord, sources: [] },
    {
      ...writerRecord,
      sources: [{ messageId: "message-1", start: 6, end: 12 }],
    },
    { ...writerRecord, kind: "explicit_pin" },
    { ...writerRecord, kind: "action_receipt" },
    { ...writerRecord, status: "superseded", supersededBy: "pin-1" },
  ])
    expect(withRecord(record).ok).toBe(false);
});

test("merged patches admit deterministic records", () => {
  const receipt = {
    ...writerRecord,
    kind: "action_receipt",
    text: JSON.stringify(chunk.messages[0]),
  };
  const patch = { ...emptyPatch, addProtected: [receipt] };
  expect(validatePatch(memory, chunk, patch).ok).toBe(false);
  expect(validatePatch(memory, chunk, patch, "merged").ok).toBe(true);
});

test("rejects duplicate supersessions", () => {
  const constraints = {
    ...memory,
    protected: [
      {
        id: "c-1",
        kind: "constraint",
        text: "a",
        sources: [],
        status: "active",
      },
      {
        id: "c-2",
        kind: "constraint",
        text: "b",
        sources: [],
        status: "active",
      },
    ],
  } as unknown as Memory;
  const supersession = { id: "c-1", supersededBy: "c-2" };
  expect(
    validatePatch(constraints, chunk, {
      ...emptyPatch,
      supersedeProtected: [supersession],
    }).ok,
  ).toBe(true);
  expect(
    validatePatch(constraints, chunk, {
      ...emptyPatch,
      supersedeProtected: [supersession, supersession],
    }).ok,
  ).toBe(false);
});

const sourcedMemory = {
  ...memory,
  topics: [
    {
      ...memory.topics[0],
      sources: [{ messageId: "message-0", start: 2, end: 9 }],
    },
  ],
} as unknown as Memory;
const replacement = (sources: object[]) => ({
  ...emptyPatch,
  replacements: [
    {
      topicId: "topic-1",
      expectedVersion: 1,
      title: "A",
      description: "A",
      summary: "B",
      sources,
      unresolved: [],
    },
  ],
});

test("bounds source ranges to the cited message", () => {
  const length = chunk.messages[0]?.content.length ?? 0;
  const ranged = (start: number, end: number) =>
    validatePatch(
      sourcedMemory,
      chunk,
      replacement([{ messageId: "message-1", start, end }]),
    ).ok;
  expect(ranged(0, length)).toBe(true);
  expect(ranged(0, length + 1)).toBe(false);
  expect(ranged(1000, 2000)).toBe(false);
});

test("older-message ranges must already exist in memory", () => {
  for (const validate of [
    (sources: object[]) =>
      validatePatch(sourcedMemory, chunk, replacement(sources)),
    (sources: object[]) =>
      validateCompressionPatch(sourcedMemory, replacement(sources)),
  ]) {
    expect(validate([{ messageId: "message-0" }]).ok).toBe(true);
    expect(validate([{ messageId: "message-0", start: 2, end: 9 }]).ok).toBe(
      true,
    );
    expect(validate([{ messageId: "message-0", start: 2, end: 900 }]).ok).toBe(
      false,
    );
  }
});
