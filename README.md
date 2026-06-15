# pi-extension

Personal pi extension and non-sensitive sync config.

## Layout

```text
~/.pi/agent/
├── index.ts                         # pi auto-discovery entrypoint; loads all extensions
├── extensions/
│   ├── context-growth.ts            # context growth widget + Codex 5h/7d display
│   └── codex-usage.ts               # Codex subscription usage and rate-limit statusline
├── settings.example.json            # sanitized pi settings example
└── README.md
```

## Install / sync on another device

Clone this repo directly as the pi global extensions directory:

```bash
git clone git@github.com:zacktian89/pi-extension.git ~/.pi/agent
# Optional: review first, then merge/copy settings.example.json into ~/.pi/agent/settings.json
```

Reload pi after copying:

```text
/reload
```

## Commands

### Context growth commands

```text
/context-growth
/context-growth reset
/context-growth off
/context-growth on
```

Optional Codex call quotas can be supplied with environment variables:

```text
PI_CODEX_5H_CALL_QUOTA=150
PI_CODEX_WEEKLY_CALL_QUOTA=1000
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

## Privacy policy for this repo

Do not commit:

- `auth.json`
- `trust.json`
- `sessions/`
- `model-usage/`
- `codex-usage/`
- machine-local absolute paths or API keys
