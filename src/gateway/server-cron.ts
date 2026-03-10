import { resolveDefaultAgentId } from "../agents/agent-scope.js";
import type { CliDeps } from "../cli/deps.js";
import { createOutboundSendDeps } from "../cli/outbound-send-deps.js";
import { loadConfig } from "../config/config.js";
import {
  canonicalizeMainSessionAlias,
  resolveAgentIdFromSessionKey,
  resolveAgentMainSessionKey,
} from "../config/sessions.js";
import { resolveStorePath } from "../config/sessions/paths.js";
import { resolveFailureDestination, sendFailureNotificationAnnounce } from "../cron/delivery.js";
import { runCronIsolatedAgentTurn } from "../cron/isolated-agent.js";
import { resolveDeliveryTarget } from "../cron/isolated-agent/delivery-target.js";
import {
  appendCronRunLog,
  resolveCronRunLogPath,
  resolveCronRunLogPruneOptions,
} from "../cron/run-log.js";
import { CronService } from "../cron/service.js";
import { resolveCronStorePath } from "../cron/store.js";
import { normalizeHttpWebhookUrl } from "../cron/webhook-url.js";
import { formatErrorMessage } from "../infra/errors.js";
import { runHeartbeatOnce } from "../infra/heartbeat-runner.js";
import { requestHeartbeatNow } from "../infra/heartbeat-wake.js";
import { fetchWithSsrFGuard } from "../infra/net/fetch-guard.js";
import { SsrFBlockedError } from "../infra/net/ssrf.js";
import { deliverOutboundPayloads } from "../infra/outbound/deliver.js";
import { enqueueSystemEvent } from "../infra/system-events.js";
import { getChildLogger } from "../logging.js";
import { normalizeAgentId, toAgentStoreSessionKey } from "../routing/session-key.js";
import { defaultRuntime } from "../runtime.js";

export type GatewayCronState = {
  cron: CronService;
  storePath: string;
  cronEnabled: boolean;
};

const CRON_WEBHOOK_TIMEOUT_MS = 10_000;

function trimToOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function redactWebhookUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return "<invalid-webhook-url>";
  }
}

type CronWebhookTarget = {
  url: string;
  source: "delivery" | "legacy";
};

function resolveCronWebhookTarget(params: {
  delivery?: { mode?: string; to?: string };
  legacyNotify?: boolean;
  legacyWebhook?: string;
}): CronWebhookTarget | null {
  const mode = params.delivery?.mode?.trim().toLowerCase();
  if (mode === "webhook") {
    const url = normalizeHttpWebhookUrl(params.delivery?.to);
    return url ? { url, source: "delivery" } : null;
  }

  if (params.legacyNotify) {
    const legacyUrl = normalizeHttpWebhookUrl(params.legacyWebhook);
    if (legacyUrl) {
      return { url: legacyUrl, source: "legacy" };
    }
  }

  return null;
}

function buildCronWebhookHeaders(webhookToken?: string): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (webhookToken) {
    headers.Authorization = `Bearer ${webhookToken}`;
  }
  return headers;
}

async function postCronWebhook(params: {
  webhookUrl: string;
  webhookToken?: string;
  payload: unknown;
  logContext: Record<string, unknown>;
  blockedLog: string;
  failedLog: string;
  logger: ReturnType<typeof getChildLogger>;
}): Promise<void> {
  const abortController = new AbortController();
  const timeout = setTimeout(() => {
    abortController.abort();
  }, CRON_WEBHOOK_TIMEOUT_MS);

  try {
    const result = await fetchWithSsrFGuard({
      url: params.webhookUrl,
      init: {
        method: "POST",
        headers: buildCronWebhookHeaders(params.webhookToken),
        body: JSON.stringify(params.payload),
        signal: abortController.signal,
      },
    });
    await result.release();
  } catch (err) {
    if (err instanceof SsrFBlockedError) {
      params.logger.warn(
        {
          ...params.logContext,
          reason: formatErrorMessage(err),
          webhookUrl: redactWebhookUrl(params.webhookUrl),
        },
        params.blockedLog,
      );
    } else {
      params.logger.warn(
        {
          ...params.logContext,
          err: formatErrorMessage(err),
          webhookUrl: redactWebhookUrl(params.webhookUrl),
        },
        params.failedLog,
      );
    }
  } finally {
    clearTimeout(timeout);
  }
}

export function buildGatewayCronService(params: {
  cfg: ReturnType<typeof loadConfig>;
  deps: CliDeps;
  broadcast: (event: string, payload: unknown, opts?: { dropIfSlow?: boolean }) => void;
}): GatewayCronState {
  const cronLogger = getChildLogger({ module: "cron" });
  const storePath = resolveCronStorePath(params.cfg.cron?.store);
  const cronEnabled = process.env.OPENCLAW_SKIP_CRON !== "1" && params.cfg.cron?.enabled !== false;

  const resolveCronAgent = (requested?: string | null) => {
    const runtimeConfig = loadConfig();
    const normalized =
      typeof requested === "string" && requested.trim() ? normalizeAgentId(requested) : undefined;
    const hasAgent =
      normalized !== undefined &&
      Array.isArray(runtimeConfig.agents?.list) &&
      runtimeConfig.agents.list.some(
        (entry) =>
          entry && typeof entry.id === "string" && normalizeAgentId(entry.id) === normalized,
      );
    const agentId = hasAgent ? normalized : resolveDefaultAgentId(runtimeConfig);
    return { agentId, cfg: runtimeConfig };
  };

  const resolveCronSessionKey = (params: {
    runtimeConfig: ReturnType<typeof loadConfig>;
    agentId: string;
    requestedSessionKey?: string | null;
  }) => {
    const requested = params.requestedSessionKey?.trim();
    if (!requested) {
      return resolveAgentMainSessionKey({
        cfg: params.runtimeConfig,
        agentId: params.agentId,
      });
    }
    const candidate = toAgentStoreSessionKey({
      agentId: params.agentId,
      requestKey: requested,
      mainKey: params.runtimeConfig.session?.mainKey,
    });
    const canonical = canonicalizeMainSessionAlias({
      cfg: params.runtimeConfig,
      agentId: params.agentId,
      sessionKey: candidate,
    });
    if (canonical !== "global") {
      const sessionAgentId = resolveAgentIdFromSessionKey(canonical);
      if (normalizeAgentId(sessionAgentId) !== normalizeAgentId(params.agentId)) {
        return resolveAgentMainSessionKey({
          cfg: params.runtimeConfig,
          agentId: params.agentId,
        });
      }
    }
    return canonical;
  };

  const resolveCronWakeTarget = (opts?: { agentId?: string; sessionKey?: string | null }) => {
    const runtimeConfig = loadConfig();
    const requestedAgentId = opts?.agentId ? resolveCronAgent(opts.agentId).agentId : undefined;
    const derivedAgentId =
      requestedAgentId ??
      (opts?.sessionKey
        ? normalizeAgentId(resolveAgentIdFromSessionKey(opts.sessionKey))
        : undefined);
    const agentId = derivedAgentId || undefined;
    const sessionKey =
      opts?.sessionKey && agentId
        ? resolveCronSessionKey({
            runtimeConfig,
            agentId,
            requestedSessionKey: opts.sessionKey,
          })
        : undefined;
    return { runtimeConfig, agentId, sessionKey };
  };

  const defaultAgentId = resolveDefaultAgentId(params.cfg);
  const runLogPrune = resolveCronRunLogPruneOptions(params.cfg.cron?.runLog);
  const resolveSessionStorePath = (agentId?: string) =>
    resolveStorePath(params.cfg.session?.store, {
      agentId: agentId ?? defaultAgentId,
    });
  const sessionStorePath = resolveSessionStorePath(defaultAgentId);
  const warnedLegacyWebhookJobs = new Set<string>();

  const cron = new CronService({
    storePath,
    cronEnabled,
    cronConfig: params.cfg.cron,
    defaultAgentId,
    resolveSessionStorePath,
    sessionStorePath,
    enqueueSystemEvent: (text, opts) => {
      const { agentId, cfg: runtimeConfig } = resolveCronAgent(opts?.agentId);
      const sessionKey = resolveCronSessionKey({
        runtimeConfig,
        agentId,
        requestedSessionKey: opts?.sessionKey,
      });
      enqueueSystemEvent(text, { sessionKey, contextKey: opts?.contextKey });
    },
    requestHeartbeatNow: (opts) => {
      const { agentId, sessionKey } = resolveCronWakeTarget(opts);
      requestHeartbeatNow({
        reason: opts?.reason,
        agentId,
        sessionKey,
      });
    },
    runHeartbeatOnce: async (opts) => {
      const { runtimeConfig, agentId, sessionKey } = resolveCronWakeTarget(opts);
      // Merge cron-supplied heartbeat overrides (e.g. target: "last") with the
      // fully resolved agent heartbeat config so cron-triggered heartbeats
      // respect agent-specific overrides (agents.list[].heartbeat) before
      // falling back to agents.defaults.heartbeat.
      const agentEntry =
        Array.isArray(runtimeConfig.agents?.list) &&
        runtimeConfig.agents.list.find(
          (entry) =>
            entry && typeof entry.id === "string" && normalizeAgentId(entry.id) === agentId,
        );
      const agentHeartbeat =
        agentEntry && typeof agentEntry === "object" ? agentEntry.heartbeat : undefined;
      const baseHeartbeat = {
        ...runtimeConfig.agents?.defaults?.heartbeat,
        ...agentHeartbeat,
      };
      const heartbeatOverride = opts?.heartbeat
        ? { ...baseHeartbeat, ...opts.heartbeat }
        : undefined;
      return await runHeartbeatOnce({
        cfg: runtimeConfig,
        reason: opts?.reason,
        agentId,
        sessionKey,
        heartbeat: heartbeatOverride,
        deps: { ...params.deps, runtime: defaultRuntime },
      });
    },
    runIsolatedAgentJob: async ({ job, message, abortSignal }) => {
      const { agentId, cfg: runtimeConfig } = resolveCronAgent(job.agentId);
      return await runCronIsolatedAgentTurn({
        cfg: runtimeConfig,
        deps: params.deps,
        job,
        message,
        abortSignal,
        agentId,
        sessionKey: `cron:${job.id}`,
        lane: "cron",
      });
    },
    sendCronFailureAlert: async ({ job, text, channel, to, mode, accountId }) => {
      const { agentId, cfg: runtimeConfig } = resolveCronAgent(job.agentId);
      const webhookToken = trimToOptionalString(params.cfg.cron?.webhookToken);

      // Webhook mode requires a URL - fail closed if missing
      if (mode === "webhook" && !to) {
        cronLogger.warn(
          { jobId: job.id },
          "cron: failure alert webhook mode requires URL, skipping",
        );
        return;
      }

      if (mode === "webhook" && to) {
        const webhookUrl = normalizeHttpWebhookUrl(to);
        if (webhookUrl) {
          await postCronWebhook({
            webhookUrl,
            webhookToken,
            payload: {
              jobId: job.id,
              jobName: job.name,
              message: text,
            },
            logContext: { jobId: job.id },
            blockedLog: "cron: failure alert webhook blocked by SSRF guard",
            failedLog: "cron: failure alert webhook failed",
            logger: cronLogger,
          });
        } else {
          cronLogger.warn(
            {
              jobId: job.id,
              webhookUrl: redactWebhookUrl(to),
            },
            "cron: failure alert webhook URL is invalid, skipping",
          );
        }
        return;
      }

      const target = await resolveDeliveryTarget(runtimeConfig, agentId, {
        channel,
        to,
        accountId,
      });
      if (!target.ok) {
        throw target.error;
      }
      await deliverOutboundPayloads({
        cfg: runtimeConfig,
        channel: target.channel,
        to: target.to,
        accountId: target.accountId,
        threadId: target.threadId,
        payloads: [{ text }],
        deps: createOutboundSendDeps(params.deps),
      });
    },
    log: getChildLogger({ module: "cron", storePath }),
    onEvent: (evt) => {
      params.broadcast("cron", evt, { dropIfSlow: true });
      if (evt.action === "finished") {
        const webhookToken = trimToOptionalString(params.cfg.cron?.webhookToken);
        const legacyWebhook = trimToOptionalString(params.cfg.cron?.webhook);
        const job = cron.getJob(evt.jobId);
        const legacyNotify = (job as { notify?: unknown } | undefined)?.notify === true;
        const webhookTarget = resolveCronWebhookTarget({
          delivery:
            job?.delivery && typeof job.delivery.mode === "string"
              ? { mode: job.delivery.mode, to: job.delivery.to }
              : undefined,
          legacyNotify,
          legacyWebhook,
        });

        if (!webhookTarget && job?.delivery?.mode === "webhook") {
          cronLogger.warn(
            {
              jobId: evt.jobId,
              deliveryTo: job.delivery.to,
            },
            "cron: skipped webhook delivery, delivery.to must be a valid http(s) URL",
          );
        }

        if (webhookTarget?.source === "legacy" && !warnedLegacyWebhookJobs.has(evt.jobId)) {
          warnedLegacyWebhookJobs.add(evt.jobId);
          cronLogger.warn(
            {
              jobId: evt.jobId,
              legacyWebhook: redactWebhookUrl(webhookTarget.url),
            },
            "cron: deprecated notify+cron.webhook fallback in use, migrate to delivery.mode=webhook with delivery.to",
          );
        }

        if (webhookTarget && evt.summary) {
          void (async () => {
            await postCronWebhook({
              webhookUrl: webhookTarget.url,
              webhookToken,
              payload: evt,
              logContext: { jobId: evt.jobId },
              blockedLog: "cron: webhook delivery blocked by SSRF guard",
              failedLog: "cron: webhook delivery failed",
              logger: cronLogger,
            });
          })();
        }

        if (evt.status === "error" && job) {
          const failureDest = resolveFailureDestination(job, params.cfg.cron?.failureDestination);
          if (failureDest) {
            const isBestEffort =
              job.delivery?.bestEffort === true ||
              (job.payload.kind === "agentTurn" && job.payload.bestEffortDeliver === true);

            if (!isBestEffort) {
              const failureMessage = `Cron job "${job.name}" failed: ${evt.error ?? "unknown error"}`;
              const failurePayload = {
                jobId: job.id,
                jobName: job.name,
                message: failureMessage,
                status: evt.status,
                error: evt.error,
                runAtMs: evt.runAtMs,
                durationMs: evt.durationMs,
                nextRunAtMs: evt.nextRunAtMs,
              };

              if (failureDest.mode === "webhook" && failureDest.to) {
                const webhookUrl = normalizeHttpWebhookUrl(failureDest.to);
                if (webhookUrl) {
                  void (async () => {
                    await postCronWebhook({
                      webhookUrl,
                      webhookToken,
                      payload: failurePayload,
                      logContext: { jobId: evt.jobId },
                      blockedLog: "cron: failure destination webhook blocked by SSRF guard",
                      failedLog: "cron: failure destination webhook failed",
                      logger: cronLogger,
                    });
                  })();
                } else {
                  cronLogger.warn(
                    {
                      jobId: evt.jobId,
                      webhookUrl: redactWebhookUrl(failureDest.to),
                    },
                    "cron: failure destination webhook URL is invalid, skipping",
                  );
                }
              } else if (failureDest.mode === "announce") {
                const { agentId, cfg: runtimeConfig } = resolveCronAgent(job.agentId);
                void sendFailureNotificationAnnounce(
                  params.deps,
                  runtimeConfig,
                  agentId,
                  job.id,
                  {
                    channel: failureDest.channel,
                    to: failureDest.to,
                    accountId: failureDest.accountId,
                  },
                  `[Cron Failure] ${failureMessage}`,
                );
              }
            }
          }
        }

        const logPath = resolveCronRunLogPath({
          storePath,
          jobId: evt.jobId,
        });
        void appendCronRunLog(
          logPath,
          {
            ts: Date.now(),
            jobId: evt.jobId,
            action: "finished",
            status: evt.status,
            error: evt.error,
            summary: evt.summary,
            delivered: evt.delivered,
            deliveryStatus: evt.deliveryStatus,
            deliveryError: evt.deliveryError,
            sessionId: evt.sessionId,
            sessionKey: evt.sessionKey,
            runAtMs: evt.runAtMs,
            durationMs: evt.durationMs,
            nextRunAtMs: evt.nextRunAtMs,
            model: evt.model,
            provider: evt.provider,
            usage: evt.usage,
          },
          runLogPrune,
        ).catch((err) => {
          cronLogger.warn({ err: String(err), logPath }, "cron: run log append failed");
        });
      }
    },
  });

  return { cron, storePath, cronEnabled };
}

/**
 * Register the built-in notification flush cron jobs.
 *
 * Jobs are idempotent — checked by name before adding so gateway restarts
 * don't accumulate duplicate entries. Uses `systemEvent` payload so the
 * flush runs as a plain CLI command in the isolated context without
 * requiring an agent turn.
 */
export async function registerBuiltinNotifyFlushJobs(cron: CronService): Promise<void> {
  const existing = await cron.list({ includeDisabled: true });
  const existingNames = new Set(existing.map((j) => j.name));

  const jobs: Array<{ name: string; expr: string; label: string }> = [
    { name: "notify-flush-high", expr: "0 * * * *", label: "high" },
    { name: "notify-flush-medium", expr: "0 */3 * * *", label: "medium" },
  ];

  for (const job of jobs) {
    if (existingNames.has(job.name)) {
      continue;
    }
    try {
      await cron.add({
        name: job.name,
        description: `Flush ${job.label}-priority notification queue`,
        enabled: true,
        schedule: { kind: "cron", expr: job.expr },
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
        payload: { kind: "systemEvent", text: `openclaw notify flush --tier ${job.label}` },
        delivery: { mode: "none" },
      });
    } catch (err) {
      // Non-fatal: log and continue — the gateway should not fail to start
      // because of a missing flush job.
      const message = err instanceof Error ? err.message : String(err);
      getChildLogger({ module: "cron" }).warn(
        { jobName: job.name, err: message },
        "cron: failed to register builtin notify flush job",
      );
    }
  }
}

/**
 * Register the Mia heartbeat cron job that processes the task queue every 10
 * minutes. The job triggers an isolated agent turn which:
 * 1. Auto-fails stale tasks (running > 30 min)
 * 2. Picks up pending due tasks by priority
 * 3. Surfaces unnotified errors
 * 4. Reschedules recurring tasks
 *
 * Idempotent — skips if a job with the same name already exists.
 */
export async function registerBuiltinMiaHeartbeatJob(cron: CronService): Promise<void> {
  const JOB_NAME = "mia-heartbeat-tick";
  const existing = await cron.list({ includeDisabled: true });
  if (existing.some((j) => j.name === JOB_NAME)) {
    return;
  }

  const message = [
    "Run the Mia heartbeat tick. Using the mia.sqlite database:",
    "1. Auto-fail any task_queue rows stuck in 'running' for >30 minutes.",
    "2. Query pending due tasks (task_queue WHERE status='pending' AND scheduled_for <= now), ordered by priority.",
    "3. For each due task, read the task definition from the tasks table and execute its prompt.",
    "4. Check for unnotified errors (errors WHERE resolved=0 AND notified=0) — notify via Telegram if any.",
    "5. For completed recurring tasks (tasks with a schedule), enqueue the next run in task_queue.",
    "If nothing is due and no errors, respond with HEARTBEAT_OK.",
  ].join("\n");

  try {
    await cron.add({
      name: JOB_NAME,
      description: "Mia task queue heartbeat — process pending tasks every 10 minutes",
      enabled: true,
      schedule: { kind: "every", everyMs: 10 * 60 * 1000 },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: { kind: "agentTurn", message },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    getChildLogger({ module: "cron" }).warn(
      { jobName: JOB_NAME, err: msg },
      "cron: failed to register builtin mia heartbeat job",
    );
  }
}

/**
 * Register a gateway watchdog cron job that runs every 5 minutes to:
 * 1. Probe gateway health
 * 2. If down: attempt auto-repair (re-bootstrap launchd / restart systemd)
 * 3. Send a Telegram alert when the gateway goes down or recovers
 *
 * Idempotent — skips if a job with the same name already exists.
 */
export async function registerBuiltinGatewayWatchdogJob(cron: CronService): Promise<void> {
  const JOB_NAME = "gateway-watchdog";
  const existing = await cron.list({ includeDisabled: true });
  if (existing.some((j) => j.name === JOB_NAME)) {
    return;
  }

  const message = [
    "Run the gateway watchdog health check.",
    "1. Call the gateway health endpoint. If it responds, the gateway is healthy.",
    "2. If the health probe fails, check if the launchd agent (macOS) or systemd unit (Linux) is loaded.",
    "3. If the service is not loaded, re-bootstrap it (launchctl bootstrap + kickstart).",
    "4. If the service is loaded but not responding, kickstart it.",
    "5. Wait 5 seconds, then re-probe health.",
    "6. Report the result:",
    "   - If recovered: send a recovery notification via Telegram.",
    "   - If still down: send an alert via Telegram with the repair attempt details.",
    "   - If healthy and was healthy: respond with WATCHDOG_OK.",
  ].join("\n");

  try {
    await cron.add({
      name: JOB_NAME,
      description: "Gateway health watchdog — probe + auto-repair every 5 minutes",
      enabled: true,
      schedule: { kind: "every", everyMs: 5 * 60 * 1000 },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: { kind: "agentTurn", message },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    getChildLogger({ module: "cron" }).warn(
      { jobName: JOB_NAME, err: msg },
      "cron: failed to register builtin gateway watchdog job",
    );
  }
}
