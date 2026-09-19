import { writeFile } from "node:fs/promises";
import { formatReport } from "./report";
import type { ReplayAdapterMode } from "./run";
import { runReplay } from "./run";
import { runSweep } from "./sweep";

export const valueAfter = (
  args: string[],
  flag: string,
): string | undefined => {
  const index = args.indexOf(flag);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--"))
    throw new Error(`${flag} requires a value`);
  return value;
};

const adapterMode = (value: string | undefined): ReplayAdapterMode => {
  if (value === undefined) return "stub";
  if (value === "stub" || value === "recorded" || value === "live")
    return value;
  throw new Error(`unknown adapter mode: ${value}`);
};

const main = async (): Promise<void> => {
  const args = process.argv.slice(2);
  const command = args[0] === "sweep" ? "sweep" : "replay";
  const commandArgs = command === "sweep" ? args.slice(1) : args;
  const fixtures = valueAfter(commandArgs, "--fixtures");
  const adapters = adapterMode(valueAfter(commandArgs, "--adapters"));
  const manifestPath = valueAfter(commandArgs, "--manifest");
  const recordPath =
    valueAfter(commandArgs, "--policy-record") ?? "fixtures/sweep-record.json";
  if (command === "sweep") {
    if (fixtures === undefined)
      throw new Error("sweep requires --fixtures <dev-directory>");
    const result = await runSweep({
      fixtures,
      adapters,
      recordPath,
      ...(manifestPath === undefined ? {} : { manifestPath }),
    });
    console.log(JSON.stringify(result.record, null, 2));
    return;
  }

  const journal = valueAfter(commandArgs, "--journal");
  const modeValue = valueAfter(commandArgs, "--mode");
  if (
    modeValue !== undefined &&
    modeValue !== "shadow" &&
    modeValue !== "active" &&
    modeValue !== "baseline"
  )
    throw new Error(`unknown replay mode: ${modeValue}`);
  const result = await runReplay({
    ...(fixtures === undefined ? {} : { fixtures }),
    ...(journal === undefined ? {} : { journal }),
    ...(manifestPath === undefined ? {} : { manifestPath }),
    adapters,
    ...(modeValue === undefined ? {} : { mode: modeValue }),
    sweepRecordPath: recordPath,
  });
  const report = formatReport(result.metrics);
  const output = valueAfter(commandArgs, "--report");
  if (output !== undefined)
    await writeFile(
      output,
      `${JSON.stringify(result.metrics, null, 2)}\n`,
      "utf8",
    );
  console.log(report);
  if (result.fixtures.length > 0)
    console.log(
      `Expectations: asserted=${result.assertions.asserted}/${result.fixtures.length}${
        result.assertions.skipped.length === 0
          ? ""
          : `, skipped under overrides: ${result.assertions.skipped.join(", ")}`
      }`,
    );
};

if (import.meta.main)
  main().catch((cause: unknown) => {
    console.error(cause instanceof Error ? cause.message : String(cause));
    process.exitCode = 1;
  });
