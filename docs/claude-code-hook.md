# Claude Code hook

A Stop hook summarizes a Claude Code session as it happens. After every turn it
reads the session transcript and updates `peaks/<session-id>.md` in the project.
It never changes the session.

## Install

Add the hook to `~/.claude/settings.json` to cover every project, or to a
project's `.claude/settings.json` to cover only that project:

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "bun /path/to/peaks/src/hosts/claude_code/hook.ts"
          }
        ]
      }
    ]
  }
}
```

Put the model configuration from the README's configuration table in `.env` at
the peaks checkout root. The worker runs from there, so Bun loads that file;
it is gitignored. Raise `WRITER_DEADLINE_MS` well above its 30,000 default:
the worker runs in the background, where a slow turn costs nothing, and a
writer timeout leaves the turn unsummarized until the next one. A run against
`google/gemini-3.8-flash` timed out repeatedly at 30,000 and passed at
120,000. Sessions that kbbl starts through claude-agent-acp load user
settings too, so a user-level hook covers them. Codex sessions are not covered.

## Modes

- `chat` (default) keeps the prompts the user sent and the assistant's text
  replies. Tool calls, tool results, thinking, injected context, slash-command
  output and the compaction summary are left out. The summary records what the
  assistant reported, not tool output it could be checked against.
- `tools` (`hook.ts --mode tools`) also keeps paired tool calls and results,
  tagged with the metadata in `src/hosts/claude_code/tools.ts`. Read-only tools
  go to the writer; state-changing tools keep a receipt; any other tool,
  including every MCP tool, is protected verbatim.

The mode applies to turns not yet summarized, so switching it mid-session
changes only later turns.

## How it runs

1. The hook records the transcript size when the turn ended, starts a detached
   worker, and exits. It never blocks Claude from stopping; a hook failure
   exits 1, which Claude Code reports without blocking.
2. The worker takes a per-session lock and reads the transcript up to that
   size, so a turn still being written is never summarized half-finished. It
   follows the active branch, so rewound messages drop out, and it crosses
   compaction boundaries.
3. Each turn, from one user prompt to the next, becomes one chunk. The worker
   ingests every turn not yet summarized, oldest first, in shadow mode: the
   writer runs on every turn and the Jev classifier's decisions are only
   journaled.
4. It rewrites `peaks/<session-id>.md`. A turn that fails stays unprocessed,
   is listed at the top of the file, and is retried after the next turn;
   later turns still proceed.
5. If another Stop arrived while it worked, it goes around again.

## Files

| Path | Contents |
| --- | --- |
| `peaks/<session-id>.md` | The rendered summary |
| `peaks/.gitignore` | Ignores `.state/`; written once |
| `peaks/.state/<session-id>.sqlite` | Memory, source archive, and journal |
| `peaks/.state/<session-id>.log` | Worker output and errors, including configuration errors |
| `peaks/.state/<session-id>.pending` | Transcript size at the latest Stop |
| `peaks/.state/<session-id>.lock` | Held by the running worker |

`peaks/` is created under `CLAUDE_PROJECT_DIR`, or the session's working
directory when that is unset. Whether the summaries themselves are committed is
up to each project.

## Limits

- The transcript format is not a published API. An entry the parser cannot
  read stops summarization for that run, and the log names the line.
- Turns already summarized from a branch that is later rewound stay in the
  summary.
- Claude Code does not fire Stop when a turn is interrupted; that turn is
  summarized after the next one completes.
- In `tools` mode, a turn whose tool output exceeds the writer's input limit
  (`WRITER_MAX_INPUT_TOKENS`, 32,000 by default) stays unprocessed. Receipts are
  never compressed, so a long session of edits and commands eventually exceeds
  the 6,000-token summary budget.
