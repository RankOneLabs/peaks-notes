import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createConfiguredAdapters } from "../adapters";
import { loadSessionConfig } from "../hosts/claude_code/session_config";
import { summarizeSession } from "../hosts/claude_code/summarize";
import { sessionDependencies } from "../hosts/claude_code/worker";
import { SqliteStore } from "../store/sqlite";

const fixture = resolve(
  process.argv[2] ?? "fixtures/demo/incident-response.jsonl",
);
const paceMs = process.argv.includes("--pace") ? 1_500 : 0;

type TranscriptLine = {
  type?: string;
  origin?: { kind?: string };
  message?: { content?: unknown };
};

export const completedTurnOffsets = (transcript: string): number[] => {
  const lines = transcript.match(/.*\n|.+$/g) ?? [];
  const promptStarts: number[] = [];
  let bytes = 0;
  for (const line of lines) {
    if (line.trim() === "") {
      bytes += Buffer.byteLength(line);
      continue;
    }
    const entry = JSON.parse(line) as TranscriptLine;
    if (entry.type === "user" && entry.origin?.kind === "human")
      promptStarts.push(bytes);
    bytes += Buffer.byteLength(line);
  }
  return promptStarts.map((_, index) => promptStarts[index + 1] ?? bytes);
};

export const promptAt = (transcript: string, turn: number): string => {
  const prompts = transcript
    .trimEnd()
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as TranscriptLine)
    .filter((entry) => entry.type === "user" && entry.origin?.kind === "human");
  return String(prompts[turn]?.message?.content ?? "");
};

const main = async (): Promise<void> => {
  const transcript = readFileSync(fixture, "utf8");
  const offsets = completedTurnOffsets(transcript);
  const outputDirectory = mkdtempSync("/tmp/peaks-live-demo-");
  const summaryPath = `${outputDirectory}/summary.md`;
  const store = new SqliteStore(`${outputDirectory}/state.sqlite`);
  try {
    const config = loadSessionConfig();
    const dependencies = {
      ...sessionDependencies(
        "peaks-live-demo",
        store,
        config,
        createConfiguredAdapters(config),
      ),
      executionPolicy: {
        mode: "active" as const,
        bypassAuditRate: 0,
        auditSeed: "peaks-live-demo",
      },
    };
    console.log(`Fixture: ${fixture}`);
    console.log("Adapters: live Jev classifier + live writer\n");
    for (const [index, untilBytes] of offsets.entries()) {
      console.log(`\n━━ SUBMITTED TURN ${index + 1}/${offsets.length} ━━`);
      console.log(promptAt(transcript, index));
      console.log("\nPeaks is processing this completed turn…\n");
      const report = await summarizeSession({
        sessionId: "peaks-live-demo",
        transcriptPath: fixture,
        untilBytes,
        summaryPath,
        mode: "tools",
        dependencies,
      });
      if (!report.ok) throw new Error(report.error.message);
      const statuses = report.value.results.map(({ status }) => status);
      console.log(
        `Result: revision ${report.value.revision} [${statuses.join(", ")}]`,
      );
      const summary = readFileSync(summaryPath, "utf8");
      writeFileSync(
        `${outputDirectory}/turn-${index + 1}.json`,
        `${JSON.stringify(
          {
            turn: index + 1,
            prompt: promptAt(transcript, index),
            revision: report.value.revision,
            statuses,
            summary,
          },
          null,
          2,
        )}\n`,
      );
      console.log(`\n${summary}`);
      if (paceMs > 0) await Bun.sleep(paceMs);
    }
    console.log(`Actual run artifacts: ${outputDirectory}`);
  } finally {
    store.close();
  }
};

if (import.meta.main)
  main().catch((cause: unknown) => {
    console.error(cause instanceof Error ? cause.message : String(cause));
    process.exitCode = 1;
  });
