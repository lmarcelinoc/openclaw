# anthropic-oauth

Registers **Anthropic (Claude Code / OAuth)** as a distinct provider in OpenClaw so it surfaces separately from the raw API-key path in `models auth login` and the model picker.

## How it works

Instead of an `ANTHROPIC_API_KEY`, this provider uses the OAuth token produced by:

```bash
claude setup-token
```

The token (`sk-ant-oat01-…`) is stored as a bearer credential under `anthropic:default`. The pi-embedded-runner detects the `sk-ant-oat` prefix at runtime and automatically adds the required OAuth beta headers (`claude-code-20250219`, `oauth-2025-04-20`).

## Setup

```bash
openclaw models auth login --provider anthropic-oauth
```

Or set the env var before running onboarding:

```bash
export CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-...
```

## Why a separate provider?

- Keeps the API-key and OAuth paths clearly differentiated in config and UI
- `CLAUDE_CODE_OAUTH_TOKEN` is forwarded to child processes (gateway, daemon) separately from `ANTHROPIC_API_KEY`
- Lets you have both an API-key profile and an OAuth profile active simultaneously with explicit ordering
