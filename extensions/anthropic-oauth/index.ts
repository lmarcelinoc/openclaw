/**
 * anthropic-oauth — registers "Anthropic (Claude Code CLI)" as a distinct
 * ProviderPlugin that routes ALL traffic through the `claude -p` subprocess.
 *
 * WHY THIS EXISTS
 * ---------------
 * The `claude setup-token` OAuth token is issued by Anthropic for the
 * Claude Code CLI *only*. Using it directly against api.anthropic.com via
 * an SDK violates Anthropic's usage policies. This provider ensures OpenClaw
 * always goes through the official `claude` CLI binary (subprocess) so no
 * direct API call is ever made with the OAuth token.
 *
 * WHAT IT DOES
 * ------------
 * 1. Verifies the `claude` binary is installed and authenticated.
 * 2. Configures the agent's primary model to `claude-cli/sonnet` (or the
 *    user's preferred alias), routing through the built-in cli-runner.
 * 3. Does NOT store any API key or OAuth token in OpenClaw credentials —
 *    the `claude` CLI manages its own auth state entirely.
 *
 * RUNTIME PATH
 * ------------
 *   OpenClaw → runCliAgent() → spawn("claude", ["-p", "--output-format", "json", ...])
 *                            → claude binary (manages its own OAuth session)
 *                            → Anthropic (via official CLI channel)
 */

import { execSync } from "node:child_process";
import {
  emptyPluginConfigSchema,
  type OpenClawPluginApi,
  type ProviderAuthContext,
  type ProviderAuthResult,
} from "openclaw/plugin-sdk";

const PROVIDER_ID = "anthropic-oauth";
const PROVIDER_LABEL = "Anthropic (Claude Code CLI)";

/** Model refs that route through the claude-cli subprocess backend. */
const DEFAULT_CLI_MODEL = "claude-cli/sonnet";
const AVAILABLE_CLI_MODELS = [
  { value: "claude-cli/sonnet", label: "Claude Sonnet (default)" },
  { value: "claude-cli/opus", label: "Claude Opus" },
  { value: "claude-cli/haiku", label: "Claude Haiku" },
];

function checkClaudeInstalled(): { ok: boolean; version?: string; error?: string } {
  try {
    const out = execSync("claude --version", { encoding: "utf8", timeout: 5000 }).trim();
    return { ok: true, version: out };
  } catch {
    return {
      ok: false,
      error:
        "claude CLI not found in PATH. Install it with: npm install -g @anthropic-ai/claude-code",
    };
  }
}

function checkClaudeAuthed(): { ok: boolean; error?: string } {
  try {
    // A fast non-interactive call to see if the session is valid.
    execSync("claude auth status", { encoding: "utf8", timeout: 8000 });
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // auth status exits non-zero when not authenticated.
    if (msg.includes("not logged in") || msg.includes("unauthenticated") || msg.includes("401")) {
      return {
        ok: false,
        error: "Not logged in. Run `claude auth login` to authenticate the Claude CLI.",
      };
    }
    // If the command doesn't exist / times out, treat as a warning (older CLI).
    return { ok: true };
  }
}

async function runClaudeCliAuth(ctx: ProviderAuthContext): Promise<ProviderAuthResult> {
  const { prompter } = ctx;

  // 1. Check the binary is available.
  const installCheck = checkClaudeInstalled();
  if (!installCheck.ok) {
    throw new Error(installCheck.error!);
  }
  await prompter.note(
    `claude CLI found: ${installCheck.version ?? "unknown version"}`,
    "Anthropic Claude Code CLI",
  );

  // 2. Check the CLI is authenticated.
  const authCheck = checkClaudeAuthed();
  if (!authCheck.ok) {
    await prompter.note(
      [
        authCheck.error!,
        "",
        "Run `claude auth login` in your terminal, then come back and re-run this setup.",
      ].join("\n"),
      "Authentication required",
    );
    throw new Error(authCheck.error!);
  }

  // 3. Let the user pick a preferred model tier.
  const modelRef = await prompter.select({
    message: "Default Claude model tier",
    options: AVAILABLE_CLI_MODELS,
    initialValue: DEFAULT_CLI_MODEL,
  });

  const chosenModel = String(modelRef ?? DEFAULT_CLI_MODEL).trim() || DEFAULT_CLI_MODEL;

  return {
    // No stored credentials — the claude CLI manages its own OAuth session.
    profiles: [],
    configPatch: {
      agents: {
        defaults: {
          // Route the primary model through the claude-cli subprocess backend.
          model: {
            primary: chosenModel,
          },
          models: Object.fromEntries(AVAILABLE_CLI_MODELS.map((m) => [m.value, {}])),
        },
      },
    },
    defaultModel: chosenModel,
    notes: [
      "All requests go through the `claude -p` CLI subprocess — no direct API calls are made.",
      "To change the model tier: `openclaw models auth login --provider anthropic-oauth`.",
      "To update the CLI session: run `claude auth login` in your terminal.",
    ],
  };
}

const anthropicOauthPlugin = {
  id: "anthropic-oauth",
  name: "Anthropic Claude Code CLI",
  description:
    "Routes all Claude requests through the `claude -p` subprocess (policy-compliant). No API key or OAuth token is stored by OpenClaw.",
  configSchema: emptyPluginConfigSchema(),

  register(api: OpenClawPluginApi) {
    api.registerProvider({
      id: PROVIDER_ID,
      label: PROVIDER_LABEL,
      docsPath: "/gateway/cli-backends",
      aliases: ["claude-code", "claude-code-cli"],
      envVars: [],
      auth: [
        {
          id: "claude-cli",
          label: "Claude Code CLI (subprocess)",
          hint: "Uses `claude -p` — requires the Claude Code CLI to be installed and authenticated",
          kind: "custom",
          run: (ctx: ProviderAuthContext) => runClaudeCliAuth(ctx),
        },
      ],
    });
  },
};

export default anthropicOauthPlugin;
