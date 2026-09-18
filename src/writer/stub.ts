import type {
  CompressInput,
  MemoryPatch,
  UpdateInput,
  Writer,
} from "../schema";
import type { StubResponse } from "../replay/fixture";

const resolve = async <T>(response: StubResponse<T> | undefined): Promise<T> => {
  if (response === undefined) throw new Error("stub response not configured");
  if (response.delayMs !== undefined) {
    await new Promise((done) => setTimeout(done, response.delayMs));
  }
  if (response.error !== undefined) throw new Error(response.error);
  if (response.output === undefined) throw new Error("stub response has no output");
  return structuredClone(response.output);
};

export type WriterStubOutputs = {
  proposals?: StubResponse<MemoryPatch>[];
  compressions?: StubResponse<MemoryPatch>[];
};

export class StubWriter implements Writer {
  readonly proposeCalls: UpdateInput[] = [];
  readonly compressCalls: CompressInput[] = [];
  readonly #proposals: StubResponse<MemoryPatch>[];
  readonly #compressions: StubResponse<MemoryPatch>[];

  constructor(outputs: WriterStubOutputs = {}) {
    this.#proposals = [...(outputs.proposals ?? [])];
    this.#compressions = [...(outputs.compressions ?? [])];
  }

  async propose(input: UpdateInput): Promise<MemoryPatch> {
    this.proposeCalls.push(structuredClone(input));
    return resolve(this.#proposals.shift());
  }

  async compress(input: CompressInput): Promise<MemoryPatch> {
    this.compressCalls.push(structuredClone(input));
    return resolve(this.#compressions.shift());
  }
}
