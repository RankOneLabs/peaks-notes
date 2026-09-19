import type { ToolAction } from "../../schema";

const readOnly: ToolAction = { effect: "read_only" };
const receipt = (...receiptArguments: string[]): ToolAction => ({
  effect: "state_changing",
  receiptArguments,
});

/**
 * Spec §5 Step A host metadata for Claude Code's built-in tools. Read-only
 * tools are local and safe to repeat. External reads (WebFetch, WebSearch)
 * cannot be assumed repeatable, so they keep a receipt. Any tool not listed,
 * including every MCP tool, carries no metadata and is protected verbatim.
 */
export const CLAUDE_CODE_TOOL_ACTIONS: Readonly<Record<string, ToolAction>> = {
  Read: readOnly,
  Glob: readOnly,
  Grep: readOnly,
  LS: readOnly,
  NotebookRead: readOnly,
  ToolSearch: readOnly,
  TaskOutput: readOnly,
  BashOutput: readOnly,
  ListAgents: readOnly,
  TodoWrite: readOnly,
  AskUserQuestion: readOnly,
  EnterPlanMode: readOnly,
  ExitPlanMode: readOnly,
  Bash: receipt("command"),
  Edit: receipt("file_path"),
  MultiEdit: receipt("file_path"),
  Write: receipt("file_path"),
  NotebookEdit: receipt("notebook_path"),
  Agent: receipt("description"),
  Task: receipt("description"),
  WebFetch: receipt("url"),
  WebSearch: receipt("query"),
};
