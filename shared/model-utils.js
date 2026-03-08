/**
 * Model utilities: aliases, provider detection, normalization.
 */

/** Map of friendly aliases to official model IDs. */
export const MODEL_ALIASES = {
  // Opus aliases
  "opus-4": "claude-opus-4-6",
  "opus-4.6": "claude-opus-4-6",
  "opus-4.5": "claude-opus-4-5",
  "opus-4.1": "claude-opus-4-1",
  "opus-4.0": "claude-opus-4-0",
  "claude-opus-4": "claude-opus-4-6",

  // Sonnet aliases
  "sonnet-4": "claude-sonnet-4-6",
  "sonnet-4.6": "claude-sonnet-4-6",
  "sonnet-4.5": "claude-sonnet-4-5",
  "sonnet-4.0": "claude-sonnet-4-0",
  "claude-sonnet-4": "claude-sonnet-4-6",

  // Haiku aliases
  "haiku-4": "claude-haiku-4-5",
  "haiku-4.5": "claude-haiku-4-5",
  "claude-haiku-4": "claude-haiku-4-5",
};

/** Provider prefixes to strip when normalizing model names. */
const PROVIDER_PREFIXES = ["anthropic/", "claude:"];

/**
 * Returns true if the model string identifies an Anthropic Claude model.
 * @param {string} model
 * @returns {boolean}
 */
export function isAnthropicModel(model) {
  if (!model) {
    return false;
  }
  const lower = model.toLowerCase();
  return (
    lower.includes("claude") ||
    lower.includes("opus") ||
    lower.includes("sonnet") ||
    lower.includes("haiku")
  );
}

/**
 * Resolve an alias to its official model ID, then strip any provider prefix.
 * If the input is already a full official ID, it is returned unchanged.
 * @param {string} model
 * @returns {string}
 */
export function normalizeAnthropicModel(model) {
  if (!model) {
    return model;
  }

  // Resolve alias first (case-insensitive key lookup)
  const alias = MODEL_ALIASES[model] ?? MODEL_ALIASES[model.toLowerCase()];
  let resolved = alias ?? model;

  // Strip known provider prefixes
  for (const prefix of PROVIDER_PREFIXES) {
    if (resolved.toLowerCase().startsWith(prefix)) {
      resolved = resolved.slice(prefix.length);
      break;
    }
  }

  return resolved;
}

/**
 * Detect which LLM provider owns a model name.
 * @param {string} model
 * @returns {'anthropic' | 'openai' | null}
 */
export function detectModelProvider(model) {
  if (!model) {
    return null;
  }
  if (isAnthropicModel(model)) {
    return "anthropic";
  }

  const lower = model.toLowerCase();
  if (
    lower.startsWith("gpt-") ||
    lower.startsWith("o1") ||
    lower.startsWith("o3") ||
    lower.startsWith("text-") ||
    lower.startsWith("openai/")
  ) {
    return "openai";
  }

  return null;
}
