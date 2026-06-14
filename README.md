# pi-extension

Personal pi extension and non-sensitive sync config.

## Contents

- `index.ts` - pi auto-discovery entrypoint that loads all extensions in this repo.
- `extensions/context-growth.ts` - context growth progress widget.
- `extensions/model-usage-report.ts` - `/usage` report for model token/cost usage; Codex calls get extra 5h/weekly quota percentage.
- `model-usage/config.json` - non-sensitive config for the usage extension, currently Codex quota limits. Runtime usage history is written to `model-usage/sessions.json` inside this extension directory and is git-ignored.
- `settings.example.json` - sanitized pi settings example. It intentionally excludes auth, trust, session history, local absolute package paths, and usage history.

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
- `model-usage/sessions.json`
- `codex-usage/sessions.json`
- machine-local absolute paths or API keys
