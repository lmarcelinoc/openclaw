import { type OpenClawConfig, loadConfig } from "../config/config.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveOpenClawAgentDir } from "./agent-paths.js";
import { resolveCliBackendIds } from "./cli-backends.js";
import { ensureOpenClawModelsJson } from "./models-config.js";

const log = createSubsystemLogger("model-catalog");

export type ModelInputType = "text" | "image" | "document";

export type ModelCatalogEntry = {
  id: string;
  name: string;
  provider: string;
  contextWindow?: number;
  reasoning?: boolean;
  input?: ModelInputType[];
};

type DiscoveredModel = {
  id: string;
  name?: string;
  provider: string;
  contextWindow?: number;
  reasoning?: boolean;
  input?: ModelInputType[];
};

type PiSdkModule = typeof import("./pi-model-discovery.js");

let modelCatalogPromise: Promise<ModelCatalogEntry[]> | null = null;
let hasLoggedModelCatalogError = false;
const defaultImportPiSdk = () => import("./pi-model-discovery.js");
let importPiSdk = defaultImportPiSdk;

const CODEX_PROVIDER = "openai-codex";
const OPENAI_PROVIDER = "openai";

// ---------------------------------------------------------------------------
// CLI backend catalog entries
// These are always available when the corresponding CLI backend is resolved.
// They never appear in models.json — the cli-runner resolves auth itself.
// ---------------------------------------------------------------------------
export const CLAUDE_CLI_PROVIDER = "claude-cli";
export const CODEX_CLI_PROVIDER = "codex-cli";

const CLAUDE_CLI_CONTEXT_WINDOW = 200_000;

const CLAUDE_CLI_CATALOG: readonly ModelCatalogEntry[] = [
  {
    id: "sonnet",
    name: "Claude Sonnet (CLI) — default",
    provider: CLAUDE_CLI_PROVIDER,
    contextWindow: CLAUDE_CLI_CONTEXT_WINDOW,
  },
  {
    id: "opus",
    name: "Claude Opus (CLI)",
    provider: CLAUDE_CLI_PROVIDER,
    contextWindow: CLAUDE_CLI_CONTEXT_WINDOW,
  },
  {
    id: "haiku",
    name: "Claude Haiku (CLI)",
    provider: CLAUDE_CLI_PROVIDER,
    contextWindow: CLAUDE_CLI_CONTEXT_WINDOW,
  },
  // Full model IDs are aliases but surface them so users can select explicitly.
  {
    id: "claude-sonnet-4-6",
    name: "claude-sonnet-4-6 (CLI)",
    provider: CLAUDE_CLI_PROVIDER,
    contextWindow: CLAUDE_CLI_CONTEXT_WINDOW,
  },
  {
    id: "claude-opus-4-6",
    name: "claude-opus-4-6 (CLI)",
    provider: CLAUDE_CLI_PROVIDER,
    contextWindow: CLAUDE_CLI_CONTEXT_WINDOW,
  },
  {
    id: "claude-haiku-3-5",
    name: "claude-haiku-3-5 (CLI)",
    provider: CLAUDE_CLI_PROVIDER,
    contextWindow: CLAUDE_CLI_CONTEXT_WINDOW,
  },
];

const CODEX_CLI_CONTEXT_WINDOW = 200_000;

const CODEX_CLI_CATALOG: readonly ModelCatalogEntry[] = [
  {
    id: "gpt-5.4",
    name: "GPT-5.4 (Codex CLI) — default",
    provider: CODEX_CLI_PROVIDER,
    contextWindow: CODEX_CLI_CONTEXT_WINDOW,
  },
  {
    id: "gpt-5.4-pro",
    name: "GPT-5.4 Pro (Codex CLI)",
    provider: CODEX_CLI_PROVIDER,
    contextWindow: CODEX_CLI_CONTEXT_WINDOW,
  },
  {
    id: "o4-mini",
    name: "o4-mini (Codex CLI)",
    provider: CODEX_CLI_PROVIDER,
    contextWindow: CODEX_CLI_CONTEXT_WINDOW,
    reasoning: true,
  },
];
const OPENAI_GPT54_MODEL_ID = "gpt-5.4";
const OPENAI_GPT54_PRO_MODEL_ID = "gpt-5.4-pro";
const OPENAI_CODEX_GPT53_MODEL_ID = "gpt-5.3-codex";
const OPENAI_CODEX_GPT53_SPARK_MODEL_ID = "gpt-5.3-codex-spark";
const OPENAI_CODEX_GPT54_MODEL_ID = "gpt-5.4";
const NON_PI_NATIVE_MODEL_PROVIDERS = new Set(["kilocode"]);

type SyntheticCatalogFallback = {
  provider: string;
  id: string;
  templateIds: readonly string[];
};

const SYNTHETIC_CATALOG_FALLBACKS: readonly SyntheticCatalogFallback[] = [
  {
    provider: OPENAI_PROVIDER,
    id: OPENAI_GPT54_MODEL_ID,
    templateIds: ["gpt-5.2"],
  },
  {
    provider: OPENAI_PROVIDER,
    id: OPENAI_GPT54_PRO_MODEL_ID,
    templateIds: ["gpt-5.2-pro", "gpt-5.2"],
  },
  {
    provider: CODEX_PROVIDER,
    id: OPENAI_CODEX_GPT54_MODEL_ID,
    templateIds: ["gpt-5.3-codex", "gpt-5.2-codex"],
  },
  {
    provider: CODEX_PROVIDER,
    id: OPENAI_CODEX_GPT53_SPARK_MODEL_ID,
    templateIds: [OPENAI_CODEX_GPT53_MODEL_ID],
  },
] as const;

/**
 * Inject static catalog entries for CLI backends (claude-cli, codex-cli, plus
 * any user-configured custom backends). These never appear in models.json so
 * we add them here — they're always available as long as the CLI is installed.
 */
function injectCliBackendCatalogEntries(
  models: ModelCatalogEntry[],
  config?: OpenClawConfig,
): void {
  const backendIds = resolveCliBackendIds(config);
  const existing = new Set(models.map((m) => `${m.provider}/${m.id}`));

  const inject = (entries: readonly ModelCatalogEntry[]) => {
    for (const entry of entries) {
      const key = `${entry.provider}/${entry.id}`;
      if (!existing.has(key)) {
        models.push({ ...entry });
        existing.add(key);
      }
    }
  };

  if (backendIds.has(CLAUDE_CLI_PROVIDER)) {
    inject(CLAUDE_CLI_CATALOG);
  }
  if (backendIds.has(CODEX_CLI_PROVIDER)) {
    inject(CODEX_CLI_CATALOG);
  }
}

function applySyntheticCatalogFallbacks(models: ModelCatalogEntry[]): void {
  const findCatalogEntry = (provider: string, id: string) =>
    models.find(
      (entry) =>
        entry.provider.toLowerCase() === provider.toLowerCase() &&
        entry.id.toLowerCase() === id.toLowerCase(),
    );

  for (const fallback of SYNTHETIC_CATALOG_FALLBACKS) {
    if (findCatalogEntry(fallback.provider, fallback.id)) {
      continue;
    }
    const template = fallback.templateIds
      .map((templateId) => findCatalogEntry(fallback.provider, templateId))
      .find((entry) => entry !== undefined);
    if (!template) {
      continue;
    }
    models.push({
      ...template,
      id: fallback.id,
      name: fallback.id,
    });
  }
}

function normalizeConfiguredModelInput(input: unknown): ModelInputType[] | undefined {
  if (!Array.isArray(input)) {
    return undefined;
  }
  const normalized = input.filter(
    (item): item is ModelInputType => item === "text" || item === "image" || item === "document",
  );
  return normalized.length > 0 ? normalized : undefined;
}

function readConfiguredOptInProviderModels(config: OpenClawConfig): ModelCatalogEntry[] {
  const providers = config.models?.providers;
  if (!providers || typeof providers !== "object") {
    return [];
  }

  const out: ModelCatalogEntry[] = [];
  for (const [providerRaw, providerValue] of Object.entries(providers)) {
    const provider = providerRaw.toLowerCase().trim();
    if (!NON_PI_NATIVE_MODEL_PROVIDERS.has(provider)) {
      continue;
    }
    if (!providerValue || typeof providerValue !== "object") {
      continue;
    }

    const configuredModels = (providerValue as { models?: unknown }).models;
    if (!Array.isArray(configuredModels)) {
      continue;
    }

    for (const configuredModel of configuredModels) {
      if (!configuredModel || typeof configuredModel !== "object") {
        continue;
      }
      const idRaw = (configuredModel as { id?: unknown }).id;
      if (typeof idRaw !== "string") {
        continue;
      }
      const id = idRaw.trim();
      if (!id) {
        continue;
      }
      const rawName = (configuredModel as { name?: unknown }).name;
      const name = (typeof rawName === "string" ? rawName : id).trim() || id;
      const contextWindowRaw = (configuredModel as { contextWindow?: unknown }).contextWindow;
      const contextWindow =
        typeof contextWindowRaw === "number" && contextWindowRaw > 0 ? contextWindowRaw : undefined;
      const reasoningRaw = (configuredModel as { reasoning?: unknown }).reasoning;
      const reasoning = typeof reasoningRaw === "boolean" ? reasoningRaw : undefined;
      const input = normalizeConfiguredModelInput((configuredModel as { input?: unknown }).input);
      out.push({ id, name, provider, contextWindow, reasoning, input });
    }
  }

  return out;
}

function mergeConfiguredOptInProviderModels(params: {
  config: OpenClawConfig;
  models: ModelCatalogEntry[];
}): void {
  const configured = readConfiguredOptInProviderModels(params.config);
  if (configured.length === 0) {
    return;
  }

  const seen = new Set(
    params.models.map(
      (entry) => `${entry.provider.toLowerCase().trim()}::${entry.id.toLowerCase().trim()}`,
    ),
  );

  for (const entry of configured) {
    const key = `${entry.provider.toLowerCase().trim()}::${entry.id.toLowerCase().trim()}`;
    if (seen.has(key)) {
      continue;
    }
    params.models.push(entry);
    seen.add(key);
  }
}

export function resetModelCatalogCacheForTest() {
  modelCatalogPromise = null;
  hasLoggedModelCatalogError = false;
  importPiSdk = defaultImportPiSdk;
}

// Test-only escape hatch: allow mocking the dynamic import to simulate transient failures.
export function __setModelCatalogImportForTest(loader?: () => Promise<PiSdkModule>) {
  importPiSdk = loader ?? defaultImportPiSdk;
}

export async function loadModelCatalog(params?: {
  config?: OpenClawConfig;
  useCache?: boolean;
}): Promise<ModelCatalogEntry[]> {
  if (params?.useCache === false) {
    modelCatalogPromise = null;
  }
  if (modelCatalogPromise) {
    return modelCatalogPromise;
  }

  modelCatalogPromise = (async () => {
    const models: ModelCatalogEntry[] = [];
    const sortModels = (entries: ModelCatalogEntry[]) =>
      entries.sort((a, b) => {
        const p = a.provider.localeCompare(b.provider);
        if (p !== 0) {
          return p;
        }
        return a.name.localeCompare(b.name);
      });
    try {
      const cfg = params?.config ?? loadConfig();
      await ensureOpenClawModelsJson(cfg);
      // IMPORTANT: keep the dynamic import *inside* the try/catch.
      // If this fails once (e.g. during a pnpm install that temporarily swaps node_modules),
      // we must not poison the cache with a rejected promise (otherwise all channel handlers
      // will keep failing until restart).
      const piSdk = await importPiSdk();
      const agentDir = resolveOpenClawAgentDir();
      const { join } = await import("node:path");
      const authStorage = piSdk.discoverAuthStorage(agentDir);
      const registry = new (piSdk.ModelRegistry as unknown as {
        new (
          authStorage: unknown,
          modelsFile: string,
        ):
          | Array<DiscoveredModel>
          | {
              getAll: () => Array<DiscoveredModel>;
            };
      })(authStorage, join(agentDir, "models.json"));
      const entries = Array.isArray(registry) ? registry : registry.getAll();
      for (const entry of entries) {
        const id = String(entry?.id ?? "").trim();
        if (!id) {
          continue;
        }
        const provider = String(entry?.provider ?? "").trim();
        if (!provider) {
          continue;
        }
        const name = String(entry?.name ?? id).trim() || id;
        const contextWindow =
          typeof entry?.contextWindow === "number" && entry.contextWindow > 0
            ? entry.contextWindow
            : undefined;
        const reasoning = typeof entry?.reasoning === "boolean" ? entry.reasoning : undefined;
        const input = Array.isArray(entry?.input) ? entry.input : undefined;
        models.push({ id, name, provider, contextWindow, reasoning, input });
      }
      mergeConfiguredOptInProviderModels({ config: cfg, models });
      injectCliBackendCatalogEntries(models, cfg);
      applySyntheticCatalogFallbacks(models);

      if (models.length === 0) {
        // If we found nothing, don't cache this result so we can try again.
        modelCatalogPromise = null;
      }

      return sortModels(models);
    } catch (error) {
      if (!hasLoggedModelCatalogError) {
        hasLoggedModelCatalogError = true;
        log.warn(`Failed to load model catalog: ${String(error)}`);
      }
      // Don't poison the cache on transient dependency/filesystem issues.
      modelCatalogPromise = null;
      if (models.length > 0) {
        return sortModels(models);
      }
      return [];
    }
  })();

  return modelCatalogPromise;
}

/**
 * Check if a model supports image input based on its catalog entry.
 */
export function modelSupportsVision(entry: ModelCatalogEntry | undefined): boolean {
  return entry?.input?.includes("image") ?? false;
}

/**
 * Check if a model supports native document/PDF input based on its catalog entry.
 */
export function modelSupportsDocument(entry: ModelCatalogEntry | undefined): boolean {
  return entry?.input?.includes("document") ?? false;
}

/**
 * Find a model in the catalog by provider and model ID.
 */
export function findModelInCatalog(
  catalog: ModelCatalogEntry[],
  provider: string,
  modelId: string,
): ModelCatalogEntry | undefined {
  const normalizedProvider = provider.toLowerCase().trim();
  const normalizedModelId = modelId.toLowerCase().trim();
  return catalog.find(
    (entry) =>
      entry.provider.toLowerCase() === normalizedProvider &&
      entry.id.toLowerCase() === normalizedModelId,
  );
}
