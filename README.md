# pi-meridian-extension

A local pi extension package for Meridian.

## What it does

- Registers a `meridian` provider.
- Auto-starts Meridian.
- Adds `/meridian`, `/meridian start`, and `/meridian version` commands.
- Rewrites the system prompt only for Meridian requests to avoid the Opus 4.6 extra-usage issue seen with pi’s default prompt.

## Install

```bash
pi install /Users/pryda/Documents/repos/pi-meridian-extension
```

## Test

```bash
pi --no-extensions -e /Users/pryda/Documents/repos/pi-meridian-extension/extensions/index.ts --no-session --model meridian/claude-opus-4-6:high --tools read --print "Reply with exactly OK and nothing else."
```
