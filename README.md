# pi-extension

Personal pi extension and non-sensitive sync config.

## Layout

```text
~/.pi/agent/extensions/pi-extension/
├── index.ts                         # pi auto-discovery entrypoint; loads all extensions
├── extensions/
│   └── context-growth.ts            # context growth widget + Codex 5h/7d display
├── settings.example.json            # sanitized pi settings example
└── README.md
```

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

## Context growth commands

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

## Privacy policy for this repo

Do not commit:

- `auth.json`
- `trust.json`
- `sessions/`
- `model-usage/`
- `codex-usage/`
- machine-local absolute paths or API keys
