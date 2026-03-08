/**
 * Unified LLM router — single entry point for all LLM calls.
 *
 * Usage:
 *   import { runLlm } from './shared/llm-router.js';
 *   const { text, durationMs } = await runLlm("Your prompt", {
 *     model: "claude-sonnet-4",   // alias resolved automatically
 *     caller: "my-script",
 *   });
 */

import { runAnthropicAgentPrompt } from "./anthropic-agent-sdk.js";
import { detectModelProvider, normalizeAnthropicModel } from "./model-utils.js";

/**
 * Route a prompt to the appropriate LLM provider and return the response.
 *
 * @param {string} prompt  The user prompt.
 * @param {object} [options]
 * @param {string}  [options.model='claude-sonnet-4-6']  Model name or alias.
 * @param {number}  [options.timeoutMs=60000]            Per-call timeout in ms.
 * @param {string}  [options.caller='unknown']           Label for log entries.
 * @param {boolean} [options.skipLog=false]              Skip interaction-store logging.
 * @returns {Promise<{ text: string, provider: string, durationMs: number }>}
 */
export async function runLlm(prompt, options = {}) {
  const {
    model = "claude-sonnet-4-6",
    timeoutMs = 60_000,
    caller = "unknown",
    skipLog = false,
  } = options;

  const start = Date.now();
  const provider = detectModelProvider(model);

  if (provider === "anthropic") {
    const result = await runAnthropicAgentPrompt({
      model: normalizeAnthropicModel(model),
      prompt,
      timeoutMs,
      caller,
      skipLog,
    });
    return { ...result, durationMs: Date.now() - start };
  }

  // Stub for OpenAI / other providers — extend here as needed
  if (provider === "openai") {
    throw new Error(
      `OpenAI provider not yet implemented. Add a handler in shared/llm-router.js ` +
        `for model: ${model}`,
    );
  }

  throw new Error(
    `Unknown provider for model "${model}". ` +
      'Pass a Claude model name or alias (e.g. "claude-sonnet-4-6", "sonnet-4", "opus-4").',
  );
}
