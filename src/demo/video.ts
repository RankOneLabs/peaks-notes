import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";

type Route = {
  route: "writer" | "bypass";
  reason: string;
  assessment?: {
    relations: Array<{ relationship: string; confidence: number }>;
    uncovered: { outcome: string; confidence: number };
  };
};
type Turn = { user: string; assistant: string };
type Snapshot = { revision: number; summary: string };

const esc = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
const compact = (value: string, length = 205): string => {
  const text = value.replaceAll(/\s+/g, " ").trim();
  return text.length <= length ? text : `${text.slice(0, length - 1).trim()}…`;
};
const content = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .flatMap((raw) => {
      if (typeof raw !== "object" || raw === null) return [];
      const block = raw as Record<string, unknown>;
      if (block.type === "text") return [String(block.text ?? "")];
      if (block.type === "tool_use")
        return [`Tool: ${String(block.name ?? "call")}`];
      if (block.type === "tool_result")
        return [`Result: ${String(block.content ?? "")}`];
      return [];
    })
    .join(" ");
};

const loadTurns = (): Turn[] => {
  const turns: Turn[] = [];
  let current: Turn | undefined;
  for (const raw of readFileSync(
    "fixtures/demo/incident-response.jsonl",
    "utf8",
  )
    .trim()
    .split("\n")) {
    const line = JSON.parse(raw) as Record<string, unknown>;
    const message = line.message as Record<string, unknown> | undefined;
    const origin = line.origin as Record<string, unknown> | undefined;
    if (line.type === "user" && origin?.kind === "human") {
      current = { user: content(message?.content), assistant: "" };
      turns.push(current);
    } else if (current !== undefined && message !== undefined) {
      current.assistant =
        `${current.assistant} ${content(message.content)}`.trim();
    }
  }
  return turns;
};

const presentation = (route?: Route) => {
  if (route?.assessment === undefined)
    return {
      label: "INITIAL TOPIC",
      detail: "no existing memory",
      action: "CREATE SUMMARY",
      tone: "new",
    };
  const relation = route.assessment.relations[0];
  if (relation?.relationship === "changing_info")
    return {
      label: "CHANGING INFO",
      detail: `confidence ${relation.confidence.toFixed(2)}`,
      action: "UPDATE SUMMARY",
      tone: "change",
    };
  if (relation?.relationship === "new_info")
    return {
      label: "NEW INFORMATION",
      detail: `confidence ${relation.confidence.toFixed(2)}`,
      action: "UPDATE SUMMARY",
      tone: "new",
    };
  if (route.route === "bypass") {
    const score = relation?.confidence ?? route.assessment.uncovered.confidence;
    return {
      label:
        route.assessment.uncovered.outcome === "transient"
          ? "TRANSIENT"
          : "ALREADY KNOWN",
      detail: `confidence ${score.toFixed(2)}`,
      action: "NO UPDATE",
      tone: "known",
    };
  }
  return {
    label: "UNCERTAIN",
    detail: "low confidence · writer review",
    action: "REVIEW SUMMARY",
    tone: "review",
  };
};

const renderSummary = (markdown: string): string => {
  const topic = markdown.match(/### ([^\n]+)\n([\s\S]*?)\nSources:/);
  if (topic === null)
    return `<div class="empty">Waiting for the first committed summary…</div>`;
  const body = topic[2]?.replaceAll(/\s+/g, " ").trim() ?? "";
  const latest = body.length > 1_180 ? `…${body.slice(-1_180)}` : body;
  const unresolved = markdown.match(/Unresolved:\n([\s\S]*?)$/)?.[1]?.trim();
  const protectedCount = (
    markdown.match(/## Active protected records\n([\s\S]*?)\n\n##/)?.[1] ?? ""
  )
    .split("\n")
    .filter((line) => line.startsWith("- [")).length;
  return `<h2>${esc(topic[1] ?? "Topic summary")}</h2>
    <div class="memory-copy">${esc(latest)}</div>
    <div class="memory-meta"><span>${protectedCount} protected records</span><span>source-linked</span></div>
    <h3>UNRESOLVED</h3><div class="unresolved">${esc(unresolved ?? "None")}</div>`;
};

const page = (args: {
  turn: number;
  phase: number;
  turns: Turn[];
  route: Route | undefined;
  before: string;
  after: string;
  revision: number;
}): string => {
  const { turn, phase, turns, route, before, after, revision } = args;
  const shown = turns.slice(Math.max(0, turn - 4), turn);
  const viewportHeight = 643;
  const pairHeight = 210;
  const finalOffset = viewportHeight - shown.length * pairHeight;
  const priorOffset =
    viewportHeight - Math.max(0, shown.length - 1) * pairHeight;
  const scrollOffset =
    priorOffset + (finalOffset - priorOffset) * (Math.min(phase, 2) / 2);
  const chat = shown
    .map(
      (item) =>
        `<div class="pair"><div class="msg user"><b>YOU</b>${esc(compact(item.user))}</div><div class="msg assistant"><b>ASSISTANT</b>${esc(compact(item.assistant, 235))}</div></div>`,
    )
    .join("");
  const decision = presentation(route);
  const decided = phase >= 2;
  const applied = phase >= 3;
  const update =
    applied &&
    route?.route !== "bypass" &&
    after.length > 0 &&
    after !== before;
  const summaryStatus = update
    ? `UPDATED · r${revision}`
    : decided
      ? route?.route === "bypass"
        ? "NO UPDATE"
        : "UPDATING…"
      : applied && route?.route !== "bypass"
        ? "RETRY QUEUED"
        : `REVISION ${revision}`;
  const summary = renderSummary(applied ? after : before);
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  *{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;overflow:hidden}body{font-family:Inter,system-ui,sans-serif;background:#070912;color:#f5f7ff}body:before{content:"";position:absolute;inset:-20%;background:radial-gradient(circle at 12% 16%,#31266b80,transparent 28%),radial-gradient(circle at 88% 82%,#0d554d60,transparent 30%);filter:blur(25px)}main{position:relative;width:1920px;height:1080px;padding:46px 62px 34px;display:flex;flex-direction:column}.top,.title,footer{display:flex;justify-content:space-between;align-items:center}.brand{font-size:22px;font-weight:900;letter-spacing:.17em}.brand i{color:#8f7dff;font-style:normal;font-size:28px}.live{color:#9da6c3;font-size:13px;letter-spacing:.11em}.live i{display:inline-block;width:8px;height:8px;background:#36e5a6;border-radius:50%;box-shadow:0 0 13px #36e5a6;margin-right:8px}.title{margin:27px 0 21px}.title h1{font-size:38px;letter-spacing:-.04em;margin:0}.title p{color:#959ebb;font-size:17px;margin:7px 0 0}.count{font:700 16px ui-monospace,monospace;color:#8f99b8}.count b{font-size:30px;color:#fff}.stage{display:grid;grid-template-columns:1fr 124px 1fr;gap:17px;flex:1;min-height:0}.pane{border:1px solid #252b40;background:linear-gradient(150deg,#131727fa,#0b0e1afa);border-radius:22px;padding:24px 27px;overflow:hidden}.pane.updated{border-color:#276857;box-shadow:0 0 34px #2bd2a914}.head{height:35px;display:flex;justify-content:space-between;color:#818aa8;font-size:12px;font-weight:850;letter-spacing:.14em}.head b{color:#32ddc5}.chat{height:643px;position:relative;overflow:hidden}.track{position:absolute;inset:0 0 auto;transform:translateY(${scrollOffset}px)}.pair{height:210px;padding:4px 0;display:flex;flex-direction:column;gap:9px}.msg{padding:12px 15px;border:1px solid #2d334a;background:#151a2b;border-radius:15px;font-size:15px;line-height:1.32;color:#dce1f2;max-height:94px;overflow:hidden}.msg b{display:block;font-size:10px;letter-spacing:.14em;color:#8e97b5;margin-bottom:5px}.msg.user{background:#211d3d;border-color:#493f78;margin-right:42px}.msg.user b{color:#aa9eff}.msg.assistant{margin-left:42px}.jev{display:flex;flex-direction:column;justify-content:center;align-items:center}.line{width:100%;height:1px;background:#343a52}.pill{width:124px;margin:11px 0;padding:15px 6px;text-align:center;border:1px solid #4054a0;border-radius:16px;background:#171d38;opacity:${decided ? 1 : 0};transform:scale(${decided ? 1 : 0.78})}.pill span{font-size:9px;font-weight:900;letter-spacing:.13em;color:#9da6c2}.pill strong{display:block;font-size:12px;line-height:1.2;margin:8px 0;color:#a9b4ff}.pill small{font:10px/1.2 ui-monospace,monospace;color:#8e97b5}.pill.known{background:#102a24;border-color:#21614f}.pill.known strong{color:#39e3a8}.pill.change{background:#322713;border-color:#765628}.pill.change strong{color:#ffca6a}.pill.review{background:#291c31;border-color:#694a77}.pill.review strong{color:#e1a8f2}.arrow{font-size:24px;color:#5c6685;opacity:${decided ? 1 : 0}.actual-summary h2{font-size:25px;margin:12px 0 18px}.memory-copy{font-size:16px;line-height:1.55;color:#d7dcec;white-space:pre-wrap}.memory-meta{display:flex;gap:10px;margin:20px 0}.memory-meta span{font-size:11px;color:#39dcb4;background:#102a24;border:1px solid #225f50;border-radius:99px;padding:7px 10px}.actual-summary h3{font-size:11px;letter-spacing:.14em;color:#8791ae;margin:22px 0 10px}.unresolved{font-size:15px;line-height:1.48;color:#b9c0d5;white-space:pre-wrap}.empty{color:#8f99b7;font-size:18px;margin-top:34px}.status{border-radius:99px;padding:7px 11px;border:1px solid ${update ? "#23674f" : "#343b55"};background:${update ? "#12362b" : "#20263a"};color:${update ? "#37e2a8" : "#9aa4c3"}!important}footer{padding-top:20px;color:#7c85a2;font-size:13px}.truth b{color:#35e1a5}.progress{display:flex;gap:5px}.progress i{width:23px;height:4px;border-radius:5px;background:#242a3e}.progress i.on{background:#7868f0}
  </style></head><body><main><div class="top"><div class="brand"><i>▲</i> PEAKS</div><div class="live"><i></i>REAL FIXTURE · LIVE JEV v6 ROUTES</div></div><div class="title"><div><h1>Conversation in. Durable summary out.</h1><p>Each completed turn is classified before memory changes.</p></div><div class="count">TURN <b>${turn}</b> / 16</div></div><section class="stage"><div class="pane"><div class="head"><span>SCROLLING CONVERSATION</span><b>LIVE</b></div><div class="chat"><div class="track">${chat}</div></div></div><div class="jev"><div class="line"></div><div class="pill ${decision.tone}"><span>JEV</span><strong>${decision.label}</strong><small>${decision.detail}</small></div><div class="arrow">→</div><div class="pill ${decision.tone}"><strong>${decision.action}</strong></div><div class="line"></div></div><div class="pane ${update ? "updated" : ""}"><div class="head"><span>ACTUAL SUMMARY.MD · LATEST CONTENT</span><b class="status">${summaryStatus}</b></div><div class="actual-summary">${summary}</div></div></section><footer><span class="truth"><b>●</b> Actual summary artifact + classifier decision from state.sqlite</span><span class="progress">${Array.from({ length: 16 }, (_, i) => `<i class="${i < turn ? "on" : ""}"></i>`).join("")}</span></footer></main></body></html>`;
};

const main = (): void => {
  const artifacts = resolve(process.argv[2] ?? "");
  if (!process.argv[2])
    throw new Error("usage: bun src/demo/video.ts <artifacts> [output]");
  const output = resolve(process.argv[3] ?? "demo/peaks-live-demo.mp4");
  mkdirSync(resolve(output, ".."), { recursive: true });
  const turns = loadTurns();
  if (turns.length !== 16)
    throw new Error(`expected 16 turns, got ${turns.length}`);
  const snapshots = new Map<number, Snapshot>();
  for (let turn = 1; turn <= 16; turn += 1) {
    snapshots.set(
      turn,
      JSON.parse(
        readFileSync(resolve(artifacts, `turn-${turn}.json`), "utf8"),
      ) as Snapshot,
    );
  }
  const db = new Database(resolve(artifacts, "state.sqlite"), {
    readonly: true,
  });
  const routes = new Map<number, Route>();
  for (let turn = 1; turn <= 16; turn += 1) {
    const row = db
      .query(
        "SELECT document FROM journal WHERE entry_type='routing_decision' AND chunk_id=? ORDER BY sequence DESC LIMIT 1",
      )
      .get(`turn-demo-u${turn}`) as { document: string } | null;
    if (row) routes.set(turn, JSON.parse(row.document) as Route);
  }
  db.close();
  const activeSummaries = new Map<number, string>([[0, ""]]);
  const activeRevisions = new Map<number, number>([[0, 0]]);
  let currentSummary = "";
  let currentRevision = 0;
  for (let turn = 1; turn <= 16; turn += 1) {
    const snapshot = snapshots.get(turn);
    if (
      routes.get(turn)?.route !== "bypass" &&
      snapshot?.summary.includes("### ")
    ) {
      currentSummary = snapshot.summary;
      currentRevision = snapshot.revision;
    }
    activeSummaries.set(turn, currentSummary);
    activeRevisions.set(turn, currentRevision);
  }
  const temporary = mkdtempSync("/tmp/peaks-scroll-video-");
  const frames: Array<{ path: string; duration: number }> = [];
  for (let turn = 1; turn <= 16; turn += 1) {
    const route = routes.get(turn);
    const revision = activeRevisions.get(turn) ?? 0;
    for (let phase = 0; phase <= 3; phase += 1) {
      const source = resolve(temporary, `${turn}-${phase}.html`);
      const image = resolve(temporary, `${turn}-${phase}.png`);
      writeFileSync(
        source,
        page({
          turn,
          phase,
          turns,
          route,
          before: activeSummaries.get(turn - 1) ?? "",
          after: activeSummaries.get(turn) ?? "",
          revision,
        }),
      );
      const chrome = Bun.spawnSync([
        "google-chrome",
        "--headless=new",
        "--no-sandbox",
        "--disable-gpu",
        "--hide-scrollbars",
        "--window-size=1920,1080",
        `--screenshot=${image}`,
        `file://${source}`,
      ]);
      if (chrome.exitCode !== 0) throw new Error(chrome.stderr.toString());
      frames.push({
        path: image,
        duration: phase === 3 ? (turn === 5 || turn >= 14 ? 2.1 : 1.45) : 0.2,
      });
    }
  }
  const manifest = resolve(temporary, "frames.txt");
  const lines = frames.flatMap((frame) => [
    `file '${frame.path}'`,
    `duration ${frame.duration}`,
  ]);
  lines.push(`file '${frames.at(-1)?.path}'`);
  writeFileSync(manifest, `${lines.join("\n")}\n`);
  const ffmpeg = Bun.spawnSync([
    "ffmpeg",
    "-y",
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    manifest,
    "-vf",
    "fps=30,format=yuv420p",
    "-c:v",
    "libx264",
    "-preset",
    "medium",
    "-crf",
    "18",
    "-movflags",
    "+faststart",
    output,
  ]);
  if (ffmpeg.exitCode !== 0) throw new Error(ffmpeg.stderr.toString());
  const cover = resolve(output, `../${basename(output, ".mp4")}-cover.png`);
  writeFileSync(cover, readFileSync(frames[3]?.path as string));
  console.log(
    `Video: ${output}\nCover: ${cover}\nSource artifacts: ${artifacts}`,
  );
};

if (import.meta.main) main();
