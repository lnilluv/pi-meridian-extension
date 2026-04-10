# pi-meridian-extension

Use your **Claude Max subscription** through [pi](https://github.com/mariozechner/pi-coding-agent) via [Meridian](https://github.com/rynfar/meridian) — a local proxy that bridges the Anthropic Messages API with Claude Code SDK authentication.

Without this extension, pi's default system prompt triggers an `"You're out of extra usage"` error on Claude Opus 4.6 (and potentially other models) when routed through Meridian. This extension rewrites the system prompt **only for Meridian requests** to avoid that issue, while leaving all other providers untouched.

## What it does

- **Registers a `meridian` provider** with 5 Claude models (Sonnet 4.5, Opus 4.5, Sonnet 4.6, Opus 4.6, Haiku 4.5)
- **Rewrites the system prompt** for Meridian requests to avoid the extra-usage error, preserving project context and working directory
- **Auto-starts Meridian** on session start if the proxy isn't running
- **Adds commands**: `/meridian` (health check), `/meridian start`, `/meridian version`

## Models

| ID | Name |
|----|------|
| `meridian/claude-sonnet-4-5` | Claude Sonnet 4.5 |
| `meridian/claude-opus-4-5` | Claude Opus 4.5 |
| `meridian/claude-sonnet-4-6` | Claude Sonnet 4.6 |
| `meridian/claude-opus-4-6` | Claude Opus 4.6 |
| `meridian/claude-haiku-4-5` | Claude Haiku 4.5 |

Use them with `--model`, e.g. `--model meridian/claude-opus-4-6:high`.

## Install

```bash
pi install npm:pi-meridian-extension
```

Requires [Meridian](https://github.com/rynfar/meridian) installed globally:

```bash
npm install -g @rynfar/meridian
```

## Configuration

| Env var | Default | Description |
|---------|---------|-------------|
| `MERIDIAN_BASE_URL` | `http://127.0.0.1:3456` | Meridian proxy URL |

## Switch to Meridian

After installing, switch your model in pi:

```
/model meridian/claude-opus-4-6:high
```

Or use it for a single command:

```bash
pi --model meridian/claude-opus-4-6:high
```

## Commands

- `/meridian` — health check (connection status, auth, mode)
- `/meridian start` — start the Meridian daemon if not running
- `/meridian version` — check installed vs latest version, update availability

## How the prompt rewrite works

When `provider === "meridian"`, the extension hooks `before_provider_request` and replaces the full system prompt with a concise version that:

1. Identifies as Claude Code operating through Meridian for pi
2. Preserves your `# Project Context` section from the original prompt
3. Preserves `Current date:` and `Current working directory:` lines
4. Drops pi's heavy default prompt that triggers the extra-usage error

All other providers continue to use pi's default system prompt unchanged.