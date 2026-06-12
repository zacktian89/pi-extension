# pi-extension

Personal pi extension and non-sensitive sync config.

## Contents

- `extensions/context-growth.ts` - context growth progress widget.
- `extensions/model-usage-report.ts` - `/usage` report for model token/cost usage; Codex calls get extra 5h/weekly quota percentage.
- `model-usage/config.json` - non-sensitive config for the usage extension, currently Codex quota limits.
- `settings.example.json` - sanitized pi settings example. It intentionally excludes auth, trust, session history, local absolute package paths, and usage history.

## Install / sync on another device

Clone this repo into a temporary directory, then copy the files into your pi agent directory:

```bash
git clone git@github.com:zacktian89/pi-extension.git
cd pi-extension
mkdir -p ~/.pi/agent/extensions ~/.pi/agent/model-usage
cp extensions/*.ts ~/.pi/agent/extensions/
cp model-usage/config.json ~/.pi/agent/model-usage/config.json
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
