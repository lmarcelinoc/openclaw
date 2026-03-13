/**
 * anthropic-oauth — registers Anthropic (Claude Code / OAuth) as a distinct
 * ProviderPlugin so it surfaces in `models auth login` and the model picker
 * separately from the raw API-key path.
 *
 * Auth flow: user runs `claude setup-token`, pastes the resulting
 * `sk-ant-oat01-…` token. The token is stored as a `token` credential under
 * the `anthropic` provider so the pi-embedded-runner can detect it and add
 * the correct OAuth beta headers automatically.
 */

import {
  emptyPluginConfigSchema,
  type OpenClawPluginApi,
  type ProviderAuthContext,
  type ProviderAuthResult,
} from "openclaw/plugin-sdk";

const PROVIDER_ID = "anthropic-oauth";
const PROVIDER_LABEL = "Anthropic (Claude Code / OAuth)";
const AUTH_PROFILE_PROVIDER = "anthropic"; // normalised provider for credential + config
const AUTH_PROFILE_ID = "anthropic:default";
const DEFAULT_MODEL = "anthropic/claude-sonnet-4-6";
const SETUP_TOKEN_PREFIX = "sk-ant-oat01-";
const SETUP_TOKEN_MIN_LENGTH = 80;
const CLAUDE_CODE_OAUTH_TOKEN_ENV = "CLAUDE_CODE_OAUTH_TOKEN";

function validateSetupToken(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return "Required";
  if (!trimmed.startsWith(SETUP_TOKEN_PREFIX))
    return `Expected token starting with ${SETUP_TOKEN_PREFIX}`;
  if (trimmed.length < SETUP_TOKEN_MIN_LENGTH)
    return "Token looks too short — paste the full setup-token output";
  return undefined;
}

async function runSetupTokenAuth(ctx: ProviderAuthContext): Promise<ProviderAuthResult> {
  const { prompter } = ctx;

  await prompter.note(
    [
      "Run `claude setup-token` in your terminal.",
      `Paste the generated token below, or pre-set ${CLAUDE_CODE_OAUTH_TOKEN_ENV} in your environment.`,
    ].join("\n"),
    "Anthropic Claude Code OAuth",
  );

  // Check env first — allows non-interactive / CI setups.
  const envToken = (process.env[CLAUDE_CODE_OAUTH_TOKEN_ENV] ?? "").trim();
  let token: string;

  if (envToken && !validateSetupToken(envToken)) {
    await prompter.note(
      `Using existing ${CLAUDE_CODE_OAUTH_TOKEN_ENV} from environment.`,
      "Anthropic Claude Code OAuth",
    );
    token = envToken;
  } else {
    const raw = await prompter.text({
      message: "Paste Anthropic setup-token",
      validate: (value) => validateSetupToken(String(value ?? "")),
    });
    token = String(raw ?? "").trim();
  }

  const validationError = validateSetupToken(token);
  if (validationError) throw new Error(validationError);

  return {
    profiles: [
      {
        profileId: AUTH_PROFILE_ID,
        credential: {
          type: "token",
          provider: AUTH_PROFILE_PROVIDER,
          token,
        },
      },
    ],
    configPatch: {
      auth: {
        profiles: {
          [AUTH_PROFILE_ID]: {
            provider: AUTH_PROFILE_PROVIDER,
            mode: "token",
          },
        },
      },
    },
    defaultModel: DEFAULT_MODEL,
    notes: [
      "OAuth tokens are not refreshed automatically. Re-run `claude setup-token` when the token expires.",
      `You can also update the token by setting ${CLAUDE_CODE_OAUTH_TOKEN_ENV} in your environment and re-running \`openclaw models auth login --provider anthropic-oauth\`.`,
    ],
  };
}

const anthropicOauthPlugin = {
  id: "anthropic-oauth",
  name: "Anthropic Claude Code OAuth",
  description:
    "Registers Anthropic as an OAuth provider using the Claude Code CLI setup-token flow instead of a raw API key.",
  configSchema: emptyPluginConfigSchema(),

  register(api: OpenClawPluginApi) {
    api.registerProvider({
      id: PROVIDER_ID,
      label: PROVIDER_LABEL,
      docsPath: "/providers/anthropic",
      aliases: ["claude-oauth", "claude-code-oauth"],
      envVars: [CLAUDE_CODE_OAUTH_TOKEN_ENV],
      auth: [
        {
          id: "setup-token",
          label: "Claude Code setup-token (OAuth)",
          hint: `Paste a token from \`claude setup-token\` — stored as ${CLAUDE_CODE_OAUTH_TOKEN_ENV}`,
          kind: "token",
          run: (ctx: ProviderAuthContext) => runSetupTokenAuth(ctx),
        },
      ],
    });
  },
};

export default anthropicOauthPlugin;
