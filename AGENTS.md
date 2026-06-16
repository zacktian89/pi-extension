# Global Pi Agent Instructions

## CodeGraph

CodeGraph is installed on this machine and available in pi through custom tools:

- `codegraph_status`: check whether the current project is indexed and healthy.
- `codegraph_query`: search indexed symbols by name or phrase.
- `codegraph_explore`: answer architecture / flow / how-does-X-work questions using related symbols and source snippets.
- `codegraph_node`: inspect one known symbol or file.
- `codegraph_callers`: find callers of a symbol.
- `codegraph_callees`: find callees called by a symbol.
- `codegraph_impact`: analyze change impact for a symbol.
- `codegraph_files`: inspect indexed file structure.

Use CodeGraph before broad `grep`, `find`, `rg`, or many `read` calls when the user asks about code structure, symbols, callers/callees, architecture, impact analysis, or where something is implemented.

If a project is not indexed, ask to run `codegraph init .` or run it when appropriate. For stale results, run `/codegraph-sync` in pi or `codegraph sync` in the shell.

## Antigravity / agy

Use `agy_delegate` for broad research, broad codebase exploration, complex planning/debugging/review, or when a second opinion is useful.

Keep agy read-only by default:

- `allowWrites=false`
- `permissionMode=default`

For detailed delegation workflow, load the `agy-delegation` skill when the task involves non-trivial research, repository exploration, planning, debugging, or review.
