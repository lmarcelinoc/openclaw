/**
 * SQLite interaction store for LLM call logging.
 * Uses node:sqlite (built-in Node 22+) in WAL mode.
 * DB path: ~/.openclaw/llm-calls.db (or LLM_LOG_DB env override).
 */

import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

/** Cost per 1M tokens (input / output) in USD, keyed by official model ID. */
export const PRICING = {
  "claude-opus-4-6": { input: 5.0, output: 25.0 },
  "claude-opus-4-5": { input: 5.0, output: 25.0 },
  "claude-opus-4-1": { input: 5.0, output: 25.0 },
  "claude-opus-4-0": { input: 5.0, output: 25.0 },
  "claude-sonnet-4-6": { input: 3.0, output: 15.0 },
  "claude-sonnet-4-5": { input: 3.0, output: 15.0 },
  "claude-sonnet-4-0": { input: 3.0, output: 15.0 },
  "claude-haiku-4-5": { input: 1.0, output: 5.0 },
};

/** Fallback pricing used when the model is not in PRICING. */
const FALLBACK_PRICING = { input: 5.0, output: 25.0 };

/** Regex patterns that look like API keys or bearer tokens — redact before storing. */
export const REDACT_RE =
  /(?:sk-ant-[A-Za-z0-9_-]{8,}|Bearer\s+[A-Za-z0-9_.-]{8,}|api[_-]?key\s*[=:]\s*\S+|oauth[_-]?token\s*[=:]\s*\S+|CLAUDE_CODE_OAUTH_TOKEN\s*=\s*\S+)/gi;

/** Replace anything matching REDACT_RE with [REDACTED]. */
export function redact(str) {
  if (!str) {
    return str;
  }
  return str.replace(REDACT_RE, "[REDACTED]");
}

/** Rough token estimate: ~4 chars per token. */
export function estimateTokensFromChars(chars) {
  return Math.ceil(chars / 4);
}

/**
 * Estimate cost in USD given a model and token counts.
 * Falls back to FALLBACK_PRICING for unknown models.
 * @param {string} model  Official model ID
 * @param {number} inputTokens
 * @param {number} outputTokens
 * @returns {number} Estimated cost in USD
 */
export function estimateCost(model, inputTokens, outputTokens) {
  const price = PRICING[model] ?? FALLBACK_PRICING;
  return (inputTokens / 1_000_000) * price.input + (outputTokens / 1_000_000) * price.output;
}

let _db = null;

/**
 * Lazily open and initialize the SQLite database.
 * @returns {DatabaseSync}
 */
export function getDb() {
  if (_db) {
    return _db;
  }

  const dbPath = process.env.LLM_LOG_DB ?? join(homedir(), ".openclaw", "llm-calls.db");

  // Ensure parent directory exists
  mkdirSync(dirname(dbPath), { recursive: true });

  _db = new DatabaseSync(dbPath);
  _db.exec("PRAGMA journal_mode=WAL");
  _db.exec(`
    CREATE TABLE IF NOT EXISTS llm_calls (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp     TEXT    NOT NULL,
      provider      TEXT,
      model         TEXT,
      caller        TEXT,
      prompt        TEXT,
      response      TEXT,
      input_tokens  INTEGER,
      output_tokens INTEGER,
      cost_estimate REAL,
      duration_ms   INTEGER,
      ok            INTEGER,
      error         TEXT
    )
  `);

  return _db;
}

const MAX_TEXT = 10_000;

/**
 * Fire-and-forget insert of a single LLM call record.
 * Errors are silently swallowed so logging never breaks the caller.
 *
 * @param {object} opts
 * @param {string} opts.provider
 * @param {string} opts.model
 * @param {string} [opts.caller]
 * @param {string} [opts.prompt]
 * @param {string} [opts.response]
 * @param {number} [opts.inputTokens]
 * @param {number} [opts.outputTokens]
 * @param {number} [opts.durationMs]
 * @param {boolean} opts.ok
 * @param {string} [opts.error]
 * @param {number|null} [opts.costUsd]  Exact cost from provider (overrides estimate).
 */
export function logLlmCall({
  provider,
  model,
  caller,
  prompt,
  response,
  inputTokens,
  outputTokens,
  durationMs,
  ok,
  error,
  costUsd = null,
}) {
  try {
    const db = getDb();

    const safePrompt = redact((prompt ?? "").slice(0, MAX_TEXT));
    const safeResponse = redact((response ?? "").slice(0, MAX_TEXT));

    const inTokens = inputTokens || estimateTokensFromChars((prompt ?? "").length);
    const outTokens = outputTokens || estimateTokensFromChars((response ?? "").length);
    const cost = costUsd ?? estimateCost(model ?? "", inTokens, outTokens);

    db.prepare(`
      INSERT INTO llm_calls
        (timestamp, provider, model, caller, prompt, response,
         input_tokens, output_tokens, cost_estimate, duration_ms, ok, error)
      VALUES
        (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      new Date().toISOString(),
      provider ?? null,
      model ?? null,
      caller ?? null,
      safePrompt,
      safeResponse,
      inTokens,
      outTokens,
      cost,
      durationMs ?? null,
      ok ? 1 : 0,
      error ?? null,
    );
  } catch {
    // Never let logging blow up the caller
  }
}
