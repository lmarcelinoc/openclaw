import type { GatewayRpcOpts } from "../../cli/gateway-rpc.js";
import { callGatewayFromCli } from "../../cli/gateway-rpc.js";
/**
 * Stale cron job cleaner.
 *
 * Jobs stuck in "running" state for more than 2 hours are almost certainly
 * the result of a machine sleep, process crash, or gateway restart.  This
 * command lists them and—with --fix—marks them as failed via the Gateway.
 */
import { loadCronStore, resolveCronStorePath } from "../../cron/store.js";
import type { CronJob } from "../../cron/types.js";
import type { RuntimeEnv } from "../../runtime.js";
import { defaultRuntime } from "../../runtime.js";
import { colorize, isRich, theme } from "../../terminal/theme.js";

export type CronStaleOptions = GatewayRpcOpts & {
  /** How long a job must be "running" before it's considered stale. Default: 2 h. */
  staleAfterMs?: number;
  /** When true, patch the stale jobs to failed via Gateway RPC. */
  fix?: boolean;
  /** JSON output. */
  json?: boolean;
  /** Cron store path override. */
  storePath?: string;
};

export type StaleJob = {
  id: string;
  name: string;
  runningAtMs: number;
  stuckForMs: number;
};

export async function detectCronStale(
  options: CronStaleOptions = {},
  runtime: RuntimeEnv = defaultRuntime,
): Promise<StaleJob[]> {
  const staleAfterMs = options.staleAfterMs ?? 2 * 60 * 60_000;
  const storePath = resolveCronStorePath(options.storePath);
  const now = Date.now();

  let jobs: CronJob[];
  try {
    const store = await loadCronStore(storePath);
    jobs = store.jobs;
  } catch (err) {
    runtime.error(`Cannot read cron store: ${String(err)}`);
    return [];
  }

  const stale: StaleJob[] = jobs
    .filter((j): j is CronJob & { state: { runningAtMs: number } } => {
      const runAt = j.state.runningAtMs;
      return typeof runAt === "number" && runAt > 0 && now - runAt >= staleAfterMs;
    })
    .map((j) => ({
      id: j.id,
      name: j.name,
      runningAtMs: j.state.runningAtMs,
      stuckForMs: now - j.state.runningAtMs,
    }));

  if (options.json && !options.fix) {
    runtime.log(JSON.stringify(stale, null, 2));
    return stale;
  }

  const rich = isRich();

  if (stale.length === 0) {
    runtime.log(colorize(rich, theme.success, "No stale cron jobs found."));
    return stale;
  }

  runtime.log(
    colorize(
      rich,
      options.fix ? theme.warn : theme.info,
      `${stale.length} stale job(s) stuck in "running" for >${Math.round(staleAfterMs / 3_600_000)}h:`,
    ),
  );

  for (const job of stale) {
    const stuckH = (job.stuckForMs / 3_600_000).toFixed(1);
    const since = new Date(job.runningAtMs).toISOString().slice(0, 19) + "Z";
    runtime.log(
      `  ${colorize(rich, theme.warn, "●")} ${colorize(rich, theme.info, job.name)}  ` +
        colorize(rich, theme.muted, `(id: ${job.id}, stuck ${stuckH}h since ${since})`),
    );
  }

  if (!options.fix) {
    runtime.log(
      colorize(rich, theme.muted, "\nRun with --fix to mark these jobs as failed via the Gateway."),
    );
    return stale;
  }

  // Patch each stale job via the gateway.
  runtime.log("");
  const results: Array<{ id: string; name: string; ok: boolean; error?: string }> = [];

  for (const job of stale) {
    try {
      await callGatewayFromCli(
        "cron.update",
        options,
        {
          id: job.id,
          state: {
            runningAtMs: undefined,
            lastRunStatus: "error",
            lastError: `Marked failed by diag stale-cleaner after ${Math.round(job.stuckForMs / 3_600_000)}h stuck`,
          },
        },
        { progress: false },
      );
      results.push({ id: job.id, name: job.name, ok: true });
      runtime.log(`  ${colorize(rich, theme.success, "fixed")}  ${job.name}`);
    } catch (err) {
      results.push({ id: job.id, name: job.name, ok: false, error: String(err) });
      runtime.log(
        `  ${colorize(rich, theme.error, "error")}  ${job.name}: ${String(err).slice(0, 80)}`,
      );
    }
  }

  if (options.json) {
    runtime.log(JSON.stringify({ stale, results }, null, 2));
  }

  return stale;
}
