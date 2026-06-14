# pi-extension

Personal pi extension and non-sensitive sync config.

## Layout

```text
~/.pi/agent/extensions/pi-extension/
├── index.ts                         # pi auto-discovery entrypoint; loads all extensions
├── extensions/
│   ├── context-growth.ts            # context growth widget + Codex 5h/7d quota remaining
│   └── model-usage-report.ts        # /usage report for token/cost/Codex call usage
├── model-usage/                     # local runtime data, git-ignored
│   ├── sessions.json                # generated usage history
│   └── config.json                  # generated only if /usage quota ... is used
├── settings.example.json            # sanitized pi settings example
└── README.md
```

`model-usage/` is intentionally local-only. Do not commit generated usage history or quota config.

## Install / sync on another device

Clone this repo directly under the pi global extensions directory:

```bash
mkdir -p ~/.pi/agent/extensions
git clone git@github.com:zacktian89/pi-extension.git ~/.pi/agent/extensions/pi-extension
# Optional: review first, then merge/copy settings.example.json into ~/.pi/agent/settings.json
```

Reload pi after copying:

```text
/reload
```

## Usage report commands

```text
/usage
/usage all
/usage quota 5h=150 week=1000
```

Codex quota percentage uses Codex-call count, not token count. General token/cost stats still work for all models.

## Privacy policy for this repo

Do not commit:

- `auth.json`
- `trust.json`
- `sessions/`
- `model-usage/`
- `codex-usage/`
- machine-local absolute paths or API keys
