import type { ToolAction } from "../../schema";

const readOnly: ToolAction = { effect: "read_only" };
const receipt = (...receiptArguments: string[]): ToolAction => ({
  effect: "state_changing",
  receiptArguments,
});

/**
 * Spec §5 Step A host metadata for Claude Code's built-in tools. Read-only
 * tools read local state and are safe to repeat. External reads (WebFetch,
 * WebSearch) cannot be assumed repeatable, so they keep a receipt. Any tool not
 * listed carries no metadata and is protected verbatim: every MCP tool, and
 * also the tools that change the session itself or carry the user's own words
 * (TodoWrite, AskUserQuestion, the plan-mode tools), whose call and result a
 * receipt could not hold.
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
