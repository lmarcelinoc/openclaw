# anthropic-oauth

Registers **Anthropic (Claude Code CLI)** as a distinct provider that routes all traffic through the `claude -p` CLI subprocess.

## Why not the SDK?

Anthropic's `claude setup-token` OAuth token is issued for the **Claude Code CLI only**. Using it directly against `api.anthropic.com` via an SDK violates Anthropic's usage policies. This provider ensures OpenClaw never makes direct API calls with the OAuth token — it always goes through the official `claude` binary.

## Runtime path

```
OpenClaw → runCliAgent() → spawn("claude", ["-p", "--output-format", "json", ...])
                         → claude binary  (manages its own OAuth session)
                         → Anthropic  (via official CLI channel)
```

No API key or OAuth token is ever stored in OpenClaw credentials.

## Prerequisites

```bash
npm install -g @anthropic-ai/claude-code
claude auth login
```

## Setup

```bash
openclaw models auth login --provider anthropic-oauth
```

The auth flow will:
1. Verify `claude` is installed and reachable in PATH
2. Verify the CLI session is authenticated
3. Let you pick a model tier (sonnet / opus / haiku)
4. Configure `agents.defaults.model.primary` to `claude-cli/<tier>`

## Changing the model tier

Re-run the auth flow:

```bash
openclaw models auth login --provider anthropic-oauth
```

Or edit config directly:

```json5
{
  agents: {
    defaults: {
      model: { primary: "claude-cli/opus" }
    }
  }
}
```

## Using as fallback

```json5
{
  agents: {
    defaults: {
      model: {
        primary: "anthropic/claude-sonnet-4-6",
        fallbacks: ["claude-cli/sonnet"]
      }
    }
  }
}
```
