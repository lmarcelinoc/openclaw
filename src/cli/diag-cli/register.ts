/**
 * `openclaw diag` — diagnostic toolkit CLI.
 *
 * Subcommands:
 *   health               System health check (gateway port + RPC + logs)
 *   cron history         Query cron run history with filters
 *   cron failures        Detect jobs that have failed 3+ times in 6h
 *   cron stale           List (or fix) jobs stuck "running" for >2h
 *   logs                 Unified event-log viewer
 *   model status         Show active model, provider, fallback chain
 *   model canary         Verify gateway routing + provider auth
 *   usage                Aggregated usage dashboard
 */
import type { Command } from "commander";
import { parseTimeArg } from "../../commands/diag/cron-history.js";
import { formatDocsLink } from "../../terminal/links.js";
import { theme } from "../../terminal/theme.js";
import { addGatewayClientOptions } from "../gateway-rpc.js";

export function registerDiagCli(program: Command) {
  const diag = program
    .command("diag")
    .description("Diagnostic tools (health checks, cron debugging, log viewer, usage stats)")
    .addHelpText(
      "after",
      () =>
        `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/diag", "docs.openclaw.ai/cli/diag")}\n`,
    );

  // -------------------------------------------------------------------------
  // diag health
  // -------------------------------------------------------------------------
  addGatewayClientOptions(
    diag
      .command("health")
      .description("System health check: gateway port, health RPC, event log, file log")
      .option("--window <duration>", "Look-back window for error scanning (e.g. 1h, 30m)", "1h")
      .option("--force", "Print results even when within alert backoff period", false)
      .option("--json", "Output JSON", false),
  ).action(async (opts) => {
    const { runSystemHealthCheck } = await import("../../commands/diag/system-health.js");
    const windowMs = parseDurationMs(opts.window) ?? 60 * 60_000;
    await runSystemHealthCheck({ ...opts, recentWindowMs: windowMs });
  });

  // -------------------------------------------------------------------------
  // diag cron
  // -------------------------------------------------------------------------
  const cron = diag.command("cron").description("Cron job debugging tools");

  addGatewayClientOptions(
    cron
      .command("history")
      .description("Query cron run history with filters")
      .option("--job <name-or-id>", "Filter to a specific job (name substring or exact ID)")
      .option("--status <filter>", "Status filter: ok | error | skipped | all", "all")
      .option("--since <time>", "Start time (ISO date, or relative like 2h, 30m)")
      .option("--until <time>", "End time (ISO date or relative)")
      .option("--grep <text>", "Case-insensitive substring filter")
      .option("--limit <n>", "Max entries to show", "50")
      .option("--store <path>", "Cron store path override")
      .option("--json", "Output JSON", false),
  ).action(async (opts) => {
    const { runCronHistory } = await import("../../commands/diag/cron-history.js");
    const sinceMs = opts.since ? (parseTimeArg(opts.since) ?? undefined) : undefined;
    const untilMs = opts.until ? (parseTimeArg(opts.until) ?? undefined) : undefined;
    await runCronHistory({
      job: opts.job,
      status: opts.status,
      sinceMs,
      untilMs,
      grep: opts.grep,
      limit: parseInt(opts.limit, 10),
      json: opts.json,
      storePath: opts.store,
    });
  });

  cron
    .command("failures")
    .description("Flag jobs with 3+ failures in a 6-hour window (persistent vs. one-off)")
    .option("--threshold <n>", "Failure count to flag", "3")
    .option("--window <duration>", "Rolling window (e.g. 6h, 1h)", "6h")
    .option("--store <path>", "Cron store path override")
    .option("--json", "Output JSON", false)
    .action(async (opts) => {
      const { detectCronFailures } = await import("../../commands/diag/cron-failures.js");
      await detectCronFailures({
        threshold: parseInt(opts.threshold, 10),
        windowMs: parseDurationMs(opts.window) ?? 6 * 60 * 60_000,
        json: opts.json,
        storePath: opts.store,
      });
    });

  addGatewayClientOptions(
    cron
      .command("stale")
      .description("List (and optionally fix) cron jobs stuck in 'running' for >2h")
      .option("--stale-after <duration>", "Threshold for 'stuck' (e.g. 2h, 30m)", "2h")
      .option("--fix", "Patch stale jobs to failed via Gateway", false)
      .option("--store <path>", "Cron store path override")
      .option("--json", "Output JSON", false),
  ).action(async (opts) => {
    const { detectCronStale } = await import("../../commands/diag/cron-stale.js");
    await detectCronStale({
      staleAfterMs: parseDurationMs(opts.staleAfter) ?? 2 * 60 * 60_000,
      fix: opts.fix,
      json: opts.json,
      storePath: opts.store,
      url: opts.url,
      token: opts.token,
      timeout: opts.timeout,
    });
  });

  // -------------------------------------------------------------------------
  // diag logs
  // -------------------------------------------------------------------------
  diag
    .command("logs")
    .description("Unified event-log viewer (reads data/logs/all.jsonl)")
    .option("--event <name>", "Filter by event name or prefix (e.g. api.request or api.*)")
    .option("--level <level>", "Minimum log level: trace|debug|info|warn|error|fatal")
    .option("--grep <text>", "Case-insensitive substring filter")
    .option("--since <time>", "Start time (ISO or relative, e.g. 1h)")
    .option("--until <time>", "End time")
    .option("--limit <n>", "Max entries (default 100)", "100")
    .option("--errors", "Alias: errors/fatals in the last 1h", false)
    .option("--recent", "Alias: all levels in the last 15m", false)
    .option("--json", "Raw JSONL output", false)
    .action(async (opts) => {
      const { runLogView } = await import("../../commands/diag/log-view.js");
      const sinceMs = opts.since ? (parseTimeArg(opts.since) ?? undefined) : undefined;
      const untilMs = opts.until ? (parseTimeArg(opts.until) ?? undefined) : undefined;
      await runLogView({
        event: opts.event,
        level: opts.level,
        grep: opts.grep,
        sinceMs,
        untilMs,
        limit: parseInt(opts.limit, 10),
        errors: opts.errors,
        recent: opts.recent,
        json: opts.json,
      });
    });

  // -------------------------------------------------------------------------
  // diag model
  // -------------------------------------------------------------------------
  const model = diag.command("model").description("Model and provider diagnostics");

  addGatewayClientOptions(
    model
      .command("status")
      .description("Show active model, provider, fallback chain, and last cron run model")
      .option("--store <path>", "Cron store path override")
      .option("--json", "Output JSON", false),
  ).action(async (opts) => {
    const { runModelStatus } = await import("../../commands/diag/model-status.js");
    await runModelStatus({ ...opts, storePath: opts.store });
  });

  addGatewayClientOptions(
    model
      .command("canary")
      .description("Verify gateway routing and provider auth with a lightweight probe")
      .option("--store <path>", "Cron store path override")
      .option("--json", "Output JSON", false),
  ).action(async (opts) => {
    const { runModelCanary } = await import("../../commands/diag/model-status.js");
    await runModelCanary({ ...opts, storePath: opts.store });
  });

  // -------------------------------------------------------------------------
  // diag usage
  // -------------------------------------------------------------------------
  addGatewayClientOptions(
    diag
      .command("usage")
      .description("Aggregated dashboard: tokens, cron reliability, storage, API call counts")
      .option("--window <duration>", "Look-back window (e.g. 7d, 24h)", "7d")
      .option("--store <path>", "Cron store path override")
      .option("--json", "Output JSON", false),
  ).action(async (opts) => {
    const { runUsageDashboard } = await import("../../commands/diag/usage.js");
    await runUsageDashboard({
      ...opts,
      windowMs: parseDurationMs(opts.window) ?? 7 * 24 * 60 * 60_000,
      storePath: opts.store,
    });
  });
}

// ---------------------------------------------------------------------------
// Local helper — avoids importing from the commands layer at registration time.
// ---------------------------------------------------------------------------

function parseDurationMs(input: string | undefined): number | null {
  if (!input) {
    return null;
  }
  const match = input.trim().match(/^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/i);
  if (!match) {
    return null;
  }
  const n = Number.parseFloat(match[1] ?? "");
  if (!Number.isFinite(n) || n <= 0) {
    return null;
  }
  const unit = (match[2] ?? "").toLowerCase();
  const factor =
    unit === "ms"
      ? 1
      : unit === "s"
        ? 1_000
        : unit === "m"
          ? 60_000
          : unit === "h"
            ? 3_600_000
            : 86_400_000;
  return Math.floor(n * factor);
}
