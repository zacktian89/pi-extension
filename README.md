# pi-extension

Personal Pi global extension and agent configuration package.

This repository is intended to be cloned into `~/.pi/agent` to sync reusable Pi extensions, global agent rules, and non-sensitive skills across machines.

## Features

- **Context growth widget**: colored context usage and growth indicator.
- **Codex usage status**: ChatGPT/Codex subscription usage and rate-limit statusline.
- **CodeGraph tools**: local code structure, symbol, caller/callee, and impact-analysis helpers.
- **agy delegation tool**: delegates broad research, repository exploration, planning, debugging, review, and test-design tasks to the local Antigravity CLI (`agy`).
- **Global agent rules**: `AGENTS.md` provides lightweight defaults for CodeGraph and agy delegation.
- **agy delegation skill**: `skills/agy-delegation/SKILL.md` contains the detailed workflow for safe, read-only-first agy delegation.

## Install / sync on another device

Clone this repo directly as the Pi global agent directory:

```bash
git clone git@github.com:zacktian89/pi-extension.git ~/.pi/agent
```

Optional: review first, then merge/copy `settings.example.json` into `~/.pi/agent/settings.json`.

Reload Pi after copying or pulling updates:

```text
/reload
```

## Layout

```text
~/.pi/agent/
├── AGENTS.md                         # global Pi agent instructions
├── index.ts                          # package entrypoint for selected extensions
├── extensions/
│   ├── agy-delegate.ts               # agy delegation tool
│   ├── codegraph.ts                  # CodeGraph tool integration
│   ├── context-growth.ts             # context growth widget
│   ├── codex-usage.ts                # Codex usage/rate-limit statusline
│   └── package.json                  # runtime dependency for agy PTY support
├── skills/
│   └── agy-delegation/
│       └── SKILL.md                  # detailed agy delegation workflow
├── settings.example.json             # sanitized Pi settings example
└── README.md
```

## Commands

### Context growth commands

```text
/context-growth
/context-growth reset
/context-growth off
/context-growth on
```

### Codex usage status commands

```text
/codex-status [--refresh] [--no-statusline] [--clear-statusline] [--timeout seconds]
```

Shows Codex ChatGPT subscription usage and rate-limit windows (5h, weekly, and credits) in a status line and notification popup.

Options:

- `--refresh`: Force refresh the usage data (bypasses cache).
- `--no-statusline`: Do not display or update the statusline.
- `--clear-statusline`: Clear the Codex status from the statusline.
- `--timeout seconds`: Timeout for querying usage (defaults to 15 seconds, max 120).

## agy delegation

The `agy_delegate` tool is for tasks that benefit from broad, independent exploration:

- web/documentation research,
- ecosystem or library comparison,
- repository-wide exploration,
- cross-file flow tracing,
- complex planning/debugging/review,
- refactor risk analysis,
- test strategy or second opinions.

Default policy:

```json
{
  "allowWrites": false,
  "permissionMode": "default"
}
```

Pi remains responsible for final edits, verification, and user-facing conclusions. See `skills/agy-delegation/SKILL.md` for the detailed workflow.

## Privacy policy for this repo

Do not commit secrets, local state, user sessions, trust decisions, usage history, or machine-specific configuration.

Intentionally ignored examples:

- `auth.json`
- `trust.json`
- `settings.json`
- `sessions/`
- `model-usage/`
- `codex-usage/`
- `extensions/node_modules/`
- `extensions/package-lock.json`
- machine-local absolute paths
- API keys, tokens, passwords, cookies, or credentials

Before committing new files, check for sensitive values such as:

- `api_key`, `token`, `secret`, `password`
- `Authorization`, `Bearer`
- provider keys such as `sk-*`
- GitHub tokens such as `ghp_*` or `github_pat_*`
