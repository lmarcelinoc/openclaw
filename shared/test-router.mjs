import { estimateCost, estimateTokensFromChars, redact } from "./interaction-store.js";
import { runLlm } from "./llm-router.js";
/**
 * Quick smoke test for the unified LLM routing layer.
 * Run: node shared/test-router.mjs
 */
import { isAnthropicModel, normalizeAnthropicModel, detectModelProvider } from "./model-utils.js";

// --- Unit checks: model-utils ---
console.log("=== model-utils ===");

const aliases = [
  ["opus-4", "claude-opus-4-6"],
  ["sonnet-4", "claude-sonnet-4-6"],
  ["haiku-4", "claude-haiku-4-5"],
  ["claude-opus-4", "claude-opus-4-6"],
];
for (const [alias, expected] of aliases) {
  const got = normalizeAnthropicModel(alias);
  const ok = got === expected;
  console.log(
    `  normalizeAnthropicModel('${alias}') → '${got}' ${ok ? "✓" : `✗ expected '${expected}'`}`,
  );
}

console.assert(isAnthropicModel("claude-opus-4-6"), "isAnthropicModel claude");
console.assert(isAnthropicModel("opus-4"), "isAnthropicModel opus");
console.assert(!isAnthropicModel("gpt-4"), "isAnthropicModel gpt");
console.assert(detectModelProvider("gpt-4o") === "openai", "provider gpt");
console.assert(detectModelProvider("claude-sonnet-4-6") === "anthropic", "provider claude");
console.assert(detectModelProvider("unknown-xyz") === null, "provider null");
console.log("  model-utils assertions passed ✓");

// --- Unit checks: interaction-store ---
console.log("\n=== interaction-store ===");
console.assert(estimateTokensFromChars(400) === 100, "token estimate");
const cost = estimateCost("claude-sonnet-4-6", 1_000_000, 500_000);
console.log(`  estimateCost sonnet 1M/0.5M → $${cost.toFixed(4)} (expected $10.50)`);
console.assert(Math.abs(cost - 10.5) < 0.001, "cost estimate");
const redacted = redact("token: sk-ant-abc123xyz Bearer eyJhbcdefghijklmnopqrstuvwxyz1234567890");
console.assert(!redacted.includes("sk-ant-"), `redact sk-ant- (got: ${redacted})`);
console.log("  interaction-store assertions passed ✓");

// --- Live call via runLlm ---
console.log("\n=== runLlm (live call) ===");
try {
  const { text, provider, durationMs } = await runLlm(
    "Reply with exactly three words: ROUTER TEST PASSED",
    { model: "claude-haiku-4", caller: "test-router", timeoutMs: 30_000 },
  );
  console.log(`  provider : ${provider}`);
  console.log(`  durationMs: ${durationMs}`);
  console.log(`  text     : ${text.trim()}`);
  if (text.includes("ROUTER") && text.includes("TEST") && text.includes("PASSED")) {
    console.log("  runLlm live call ✓");
  } else {
    console.log("  runLlm returned unexpected text (but call succeeded)");
  }
} catch (err) {
  console.error("  runLlm failed:", err.message);
  process.exit(1);
}

console.log("\nAll checks passed.");
