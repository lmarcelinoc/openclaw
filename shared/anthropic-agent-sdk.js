/**
 * Anthropic Claude Agent SDK wrapper with OAuth authentication.
 *
 * OAuth token resolution order (runs at module load):
 *   1. CLAUDE_CODE_OAUTH_TOKEN env var
 *   2. .env file in process.cwd()
 *   3. Throws if neither found, or if ANTHROPIC_API_KEY is also set (conflict).
 *
 * Set ANTHROPIC_SKIP_SMOKE_TEST=1 to skip the startup AUTH_OK check.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { logLlmCall } from "./interaction-store.js";

// ---------------------------------------------------------------------------
// OAuth token resolution (module-load time)
// ---------------------------------------------------------------------------

function resolveOauthToken() {
  // 1. Check env var first
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    return;
  }

  // 2. Try to parse from .env file
  const envPath = join(process.cwd(), ".env");
  let envContents = "";
  try {
    envContents = readFileSync(envPath, "utf8");
  } catch {
    // No .env file — that's fine
  }

  for (const line of envContents.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("#") || !trimmed.includes("=")) {
      continue;
    }
    const eqIdx = trimmed.indexOf("=");
    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed
      .slice(eqIdx + 1)
      .trim()
      .replace(/^["']|["']$/g, "");
    if (key === "CLAUDE_CODE_OAUTH_TOKEN" && value) {
      process.env.CLAUDE_CODE_OAUTH_TOKEN = value;
      break;
    }
  }

  // 3. Still missing?
  if (!process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    throw new Error(
      "No CLAUDE_CODE_OAUTH_TOKEN found in environment or .env file. " +
        "Run 'claude login' and add the token to your .env:\n" +
        "  CLAUDE_CODE_OAUTH_TOKEN=<your-token>",
    );
  }
}

function checkApiKeyConflict() {
  if (process.env.ANTHROPIC_API_KEY) {
    throw new Error(
      "ANTHROPIC_API_KEY conflicts with OAuth-only mode. " +
        "Remove ANTHROPIC_API_KEY from your environment or .env file " +
        "and use CLAUDE_CODE_OAUTH_TOKEN instead.",
    );
  }
}

// Run at module load — fail fast if credentials are misconfigured
resolveOauthToken();
checkApiKeyConflict();

// ---------------------------------------------------------------------------
// Smoke test (once per process)
// ---------------------------------------------------------------------------

let smokeTestPassed = Boolean(process.env.ANTHROPIC_SKIP_SMOKE_TEST);

async function runSmokeTest() {
  if (smokeTestPassed) {
    return;
  }

  const SMOKE_PROMPT = "Reply with exactly AUTH_OK and nothing else.";
  const SMOKE_TIMEOUT_MS = 20_000;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SMOKE_TIMEOUT_MS);

  try {
    let resultText = "";

    for await (const msg of query({
      prompt: SMOKE_PROMPT,
      options: { tools: [], maxTurns: 1, abortController: controller },
    })) {
      if (msg.type === "result" && !msg.is_error) {
        resultText = msg.result ?? "";
      }
    }

    if (!resultText.includes("AUTH_OK")) {
      throw new Error(
        `Smoke test response did not contain AUTH_OK. Got: ${resultText.slice(0, 200)}`,
      );
    }

    smokeTestPassed = true;
  } catch (err) {
    if (err.name === "AbortError" || controller.signal.aborted) {
      throw new Error(
        "Anthropic OAuth smoke test timed out (20s). " +
          "Check your CLAUDE_CODE_OAUTH_TOKEN or set ANTHROPIC_SKIP_SMOKE_TEST=1 to bypass.",
        { cause: err },
      );
    }
    throw new Error(`Anthropic OAuth smoke test failed: ${err.message}`, { cause: err });
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Main exported function
// ---------------------------------------------------------------------------

/**
 * Run a single prompt through the Anthropic Claude Agent SDK (toolless mode).
 *
 * @param {object} opts
 * @param {string} opts.prompt       The user prompt text.
 * @param {string} [opts.model]      Official model ID or alias (default: claude-sonnet-4-6).
 * @param {number} [opts.timeoutMs]  Abort after this many ms (default: 60000).
 * @param {string} [opts.caller]     Label for logging (e.g. "my-script").
 * @param {number} [opts.maxTurns]   Max agent turns (default: 1).
 * @param {boolean} [opts.skipLog]   If true, do not write to interaction store.
 * @returns {Promise<{ text: string, provider: 'anthropic' }>}
 */
export async function runAnthropicAgentPrompt({
  prompt,
  model = "claude-sonnet-4-6",
  timeoutMs = 60_000,
  caller,
  maxTurns = 1,
  skipLog = false,
}) {
  await runSmokeTest();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const start = Date.now();
  let textParts = [];
  let inputTokens = 0;
  let outputTokens = 0;
  let durationMs = 0;
  let costUsd = null;

  try {
    for await (const msg of query({
      prompt,
      options: {
        tools: [],
        maxTurns,
        model,
        abortController: controller,
      },
    })) {
      if (msg.type === "assistant") {
        // Collect text content blocks from the assistant message
        const content = msg.message?.content ?? [];
        for (const block of content) {
          if (block.type === "text") {
            textParts.push(block.text);
          }
        }
      } else if (msg.type === "result" && !msg.is_error) {
        durationMs = msg.duration_ms ?? Date.now() - start;
        // SDK result.usage uses snake_case field names at runtime
        inputTokens = msg.usage?.input_tokens ?? 0;
        outputTokens = msg.usage?.output_tokens ?? 0;
        costUsd = msg.total_cost_usd ?? null;
        // Also capture result text in case there were no assistant messages
        if (textParts.length === 0 && msg.result) {
          textParts.push(msg.result);
        }
      } else if (msg.type === "result" && msg.is_error) {
        const errMsg = (msg.errors ?? []).join("; ") || "Unknown agent error";
        throw new Error(`Agent returned error: ${errMsg}`);
      }
    }

    const text = textParts.join("");

    if (!skipLog) {
      logLlmCall({
        provider: "anthropic",
        model,
        caller,
        prompt,
        response: text,
        inputTokens,
        outputTokens,
        durationMs: durationMs || Date.now() - start,
        ok: true,
        costUsd,
      });
    }

    return { text, provider: "anthropic" };
  } catch (err) {
    const isTimeout = err.name === "AbortError" || controller.signal.aborted;
    const errorMsg = isTimeout ? `Timed out after ${timeoutMs}ms` : err.message;

    if (!skipLog) {
      logLlmCall({
        provider: "anthropic",
        model,
        caller,
        prompt,
        durationMs: Date.now() - start,
        ok: false,
        error: errorMsg,
      });
    }

    if (isTimeout) {
      throw new Error(`runAnthropicAgentPrompt timed out after ${timeoutMs}ms`, { cause: err });
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
