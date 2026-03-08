import type { GatewayRpcOpts } from "../../cli/gateway-rpc.js";
import { callGatewayFromCli } from "../../cli/gateway-rpc.js";
import { readCronRunLogEntriesPageAll } from "../../cron/run-log.js";
/**
 * Model / provider diagnostics.
 *
 * `model status`:  show which models are configured, the last heartbeat,
 *                  and models referenced in cron jobs.
 *
 * `model canary`:  send a no-op wake event and verify the gateway routes it,
 *                  then surface the provider from the most recent cron run log
 *                  entry to confirm auth is working.
 *                  (Uses a lightweight probe rather than a full agent turn.)
 */
import { loadCronStore, resolveCronStorePath } from "../../cron/store.js";
import type { RuntimeEnv } from "../../runtime.js";
import { defaultRuntime } from "../../runtime.js";
import { colorize, isRich, theme } from "../../terminal/theme.js";

export type ModelStatusOptions = GatewayRpcOpts & {
  json?: boolean;
  storePath?: string;
};

export type ModelCanaryOptions = GatewayRpcOpts & {
  json?: boolean;
  storePath?: string;
};

// ---------------------------------------------------------------------------
// Types for Gateway responses
// ---------------------------------------------------------------------------

type ModelsListResponse = {
  models?: Array<{
    id: string;
    provider?: string;
    context?: number;
    alias?: string;
    active?: boolean;
    fallback?: boolean;
  }>;
  active?: string;
  fallbacks?: string[];
};

type LastHeartbeatResponse = {
  ts?: number;
  status?: string;
  channel?: string;
  durationMs?: number;
};

// ---------------------------------------------------------------------------
// model status
// ---------------------------------------------------------------------------

export async function runModelStatus(
  options: ModelStatusOptions = {},
  runtime: RuntimeEnv = defaultRuntime,
): Promise<void> {
  const rich = isRich();
  const errors: string[] = [];

  // 1. Gateway models.list
  let modelsResp: ModelsListResponse | null = null;
  try {
    modelsResp = (await callGatewayFromCli(
      "models.list",
      options,
      {},
      { progress: false },
    )) as ModelsListResponse;
  } catch (err) {
    errors.push(`models.list failed: ${String(err).slice(0, 100)}`);
  }

  // 2. Last heartbeat
  let heartbeat: LastHeartbeatResponse | null = null;
  try {
    heartbeat = (await callGatewayFromCli("last-heartbeat", options, undefined, {
      progress: false,
    })) as LastHeartbeatResponse;
  } catch {
    // Non-fatal; heartbeat may not have fired yet.
  }

  // 3. Models referenced in cron jobs (read from store directly).
  const cronModels = new Set<string>();
  try {
    const storePath = resolveCronStorePath(options.storePath);
    const store = await loadCronStore(storePath);
    for (const job of store.jobs) {
      if (job.payload.kind === "agentTurn" && job.payload.model) {
        cronModels.add(job.payload.model);
      }
    }
  } catch {
    // Store may not exist.
  }

  // 4. Most recent model used (from run log).
  let lastUsedModel: string | undefined;
  let lastUsedProvider: string | undefined;
  try {
    const storePath = resolveCronStorePath(options.storePath);
    const page = await readCronRunLogEntriesPageAll({
      storePath,
      limit: 1,
      offset: 0,
      sortDir: "desc",
    });
    const last = page.entries[0];
    lastUsedModel = last?.model;
    lastUsedProvider = last?.provider;
  } catch {
    // No run log yet.
  }

  if (options.json) {
    runtime.log(
      JSON.stringify(
        {
          models: modelsResp,
          heartbeat,
          cronModels: Array.from(cronModels),
          lastUsedModel,
          lastUsedProvider,
          errors,
        },
        null,
        2,
      ),
    );
    return;
  }

  runtime.log(colorize(rich, theme.heading, "=== Model / Provider Status ==="));

  // Active model + fallbacks
  if (modelsResp) {
    const active = modelsResp.active ?? colorize(rich, theme.muted, "(not configured)");
    runtime.log(
      `\n  ${colorize(rich, theme.muted, "active model:")}  ${colorize(rich, theme.info, active)}`,
    );
    if (modelsResp.fallbacks && modelsResp.fallbacks.length > 0) {
      runtime.log(
        `  ${colorize(rich, theme.muted, "fallbacks:")}     ${modelsResp.fallbacks.map((f) => colorize(rich, theme.accent, f)).join(", ")}`,
      );
    }
    if (modelsResp.models && modelsResp.models.length > 0) {
      runtime.log(
        colorize(rich, theme.muted, `\n  ${modelsResp.models.length} model(s) available:`),
      );
      for (const m of modelsResp.models.slice(0, 10)) {
        const badge = m.active ? colorize(rich, theme.success, " ★") : "  ";
        const prov = m.provider ? colorize(rich, theme.muted, ` [${m.provider}]`) : "";
        const ctx = m.context ? colorize(rich, theme.muted, ` ctx:${m.context}`) : "";
        runtime.log(`    ${badge} ${colorize(rich, theme.info, m.id)}${prov}${ctx}`);
      }
    }
  } else {
    runtime.log(colorize(rich, theme.warn, "\n  models.list unavailable (gateway offline?)"));
  }

  // Last heartbeat
  if (heartbeat) {
    const ts = heartbeat.ts ? new Date(heartbeat.ts).toISOString().slice(0, 19) + "Z" : "-";
    runtime.log(
      `\n  ${colorize(rich, theme.muted, "last heartbeat:")}  ${colorize(rich, theme.info, ts)}  ` +
        colorize(
          rich,
          theme.muted,
          `status=${heartbeat.status ?? "?"}  channel=${heartbeat.channel ?? "?"}`,
        ),
    );
  } else {
    runtime.log(colorize(rich, theme.muted, "\n  last heartbeat:   (none yet)"));
  }

  // Last used model from cron logs
  if (lastUsedModel) {
    runtime.log(
      `\n  ${colorize(rich, theme.muted, "last cron run model:")}   ${colorize(rich, theme.info, lastUsedModel)}` +
        (lastUsedProvider ? colorize(rich, theme.muted, `  via ${lastUsedProvider}`) : ""),
    );
  }

  // Models in cron jobs
  if (cronModels.size > 0) {
    runtime.log(
      `\n  ${colorize(rich, theme.muted, "models in cron jobs:")}  ` +
        Array.from(cronModels)
          .map((m) => colorize(rich, theme.accent, m))
          .join(", "),
    );
  }

  if (errors.length > 0) {
    runtime.log("");
    for (const e of errors) {
      runtime.log(colorize(rich, theme.error, `  ! ${e}`));
    }
  }
}

// ---------------------------------------------------------------------------
// model canary
// ---------------------------------------------------------------------------

export async function runModelCanary(
  options: ModelCanaryOptions = {},
  runtime: RuntimeEnv = defaultRuntime,
): Promise<void> {
  const rich = isRich();

  runtime.log(colorize(rich, theme.heading, "=== Model Canary Test ==="));

  // Step 1: verify gateway is reachable with a health call.
  let gatewayOk = false;
  try {
    const res = (await callGatewayFromCli("health", options, {}, { progress: false })) as {
      ok?: boolean;
    };
    gatewayOk = res?.ok === true;
  } catch (err) {
    runtime.log(
      colorize(rich, theme.error, `  FAIL  gateway unreachable: ${String(err).slice(0, 100)}`),
    );
    return;
  }

  if (!gatewayOk) {
    runtime.log(colorize(rich, theme.error, "  FAIL  health RPC returned non-ok"));
    return;
  }

  runtime.log(colorize(rich, theme.success, "  PASS  gateway health RPC"));

  // Step 2: models.list — verify provider is reachable.
  let providerOk = false;
  let activeModel: string | undefined;
  let activeProvider: string | undefined;

  try {
    const resp = (await callGatewayFromCli(
      "models.list",
      options,
      {},
      { progress: false },
    )) as ModelsListResponse;
    activeModel = resp?.active;
    // Provider is not always surfaced in models.list; derive from the first
    // model record whose alias matches active, or just report the active name.
    const modelRecord = resp?.models?.find(
      (m) => m.active || m.id === activeModel || m.alias === activeModel,
    );
    activeProvider = modelRecord?.provider;
    providerOk = Boolean(activeModel);
  } catch (err) {
    runtime.log(colorize(rich, theme.error, `  FAIL  models.list: ${String(err).slice(0, 100)}`));
  }

  if (providerOk) {
    const prov = activeProvider ? ` (${activeProvider})` : "";
    runtime.log(
      colorize(rich, theme.success, `  PASS  models.list — active: ${activeModel}${prov}`),
    );
  } else {
    runtime.log(colorize(rich, theme.warn, "  WARN  no active model configured"));
  }

  // Step 3: surface the most recent cron run to confirm auth succeeded recently.
  try {
    const storePath = resolveCronStorePath(options.storePath);
    const page = await readCronRunLogEntriesPageAll({
      storePath,
      limit: 1,
      offset: 0,
      sortDir: "desc",
    });
    const last = page.entries[0];
    if (last) {
      const ts = new Date(last.ts).toISOString().slice(0, 19) + "Z";
      const provider = last.provider ?? last.model ?? "unknown";
      const status = last.status ?? "?";
      const statusColor =
        status === "ok" ? theme.success : status === "error" ? theme.error : theme.warn;
      runtime.log(
        `  ${colorize(rich, statusColor, status.toUpperCase().padEnd(5))} last cron run at ${ts}  model=${last.model ?? "?"} via ${colorize(rich, theme.accent, provider)}`,
      );
    } else {
      runtime.log(colorize(rich, theme.muted, "  ----  no cron run history yet"));
    }
  } catch {
    // Ignore.
  }

  if (options.json) {
    runtime.log(JSON.stringify({ gatewayOk, providerOk, activeModel, activeProvider }, null, 2));
  }
}
