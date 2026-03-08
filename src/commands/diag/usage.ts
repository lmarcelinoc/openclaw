/**
 * Usage dashboard — aggregates model costs, cron reliability, storage sizes,
 * and API call counts from one command.
 *
 * Data sources:
 *  - Gateway `usage.status` RPC  (model token usage)
 *  - Gateway `usage.cost`  RPC   (cost estimates)
 *  - Cron run logs (tokens per job, success/error rates)
 *  - Event log (all.jsonl) — API call counts by event
 *  - Filesystem sizes for key ~/.openclaw directories
 */
import fs from "node:fs/promises";
import path from "node:path";
import type { GatewayRpcOpts } from "../../cli/gateway-rpc.js";
import { callGatewayFromCli } from "../../cli/gateway-rpc.js";
import { readCronRunLogEntriesPageAll, type CronRunLogEntry } from "../../cron/run-log.js";
import { loadCronStore, resolveCronStorePath } from "../../cron/store.js";
import { resolveLogDir } from "../../event-log/writer.js";
import type { RuntimeEnv } from "../../runtime.js";
import { defaultRuntime } from "../../runtime.js";
import { colorize, isRich, theme } from "../../terminal/theme.js";
import { CONFIG_DIR } from "../../utils.js";

export type UsageOptions = GatewayRpcOpts & {
  json?: boolean;
  storePath?: string;
  /** How far back to look for cron stats. Default: 7 days. */
  windowMs?: number;
};

// ---------------------------------------------------------------------------
// Directory size helper
// ---------------------------------------------------------------------------

async function dirSizeBytes(dirPath: string): Promise<number> {
  let total = 0;
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true, recursive: true });
    await Promise.all(
      entries.map(async (entry) => {
        if (!entry.isFile()) {
          return;
        }
        const full = path.join(
          // `recursive: true` populates entry.path in Node 22+
          (entry as { path?: string }).path ?? dirPath,
          entry.name,
        );
        const stat = await fs.stat(full).catch(() => null);
        if (stat) {
          total += stat.size;
        }
      }),
    );
  } catch {
    // directory may not exist
  }
  return total;
}

function formatBytes(bytes: number): string {
  if (bytes < 1_024) {
    return `${bytes} B`;
  }
  if (bytes < 1_024 ** 2) {
    return `${(bytes / 1_024).toFixed(1)} KB`;
  }
  if (bytes < 1_024 ** 3) {
    return `${(bytes / 1_024 ** 2).toFixed(1)} MB`;
  }
  return `${(bytes / 1_024 ** 3).toFixed(2)} GB`;
}

// ---------------------------------------------------------------------------
// Event-log API call counter
// ---------------------------------------------------------------------------

async function countEventLogCalls(
  logDir: string,
  windowMs: number,
): Promise<Record<string, number>> {
  const filePath = path.join(logDir, "all.jsonl");
  const cutoff = Date.now() - windowMs;
  const counts: Record<string, number> = {};
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf-8");
  } catch {
    return counts;
  }
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      const obj = JSON.parse(trimmed) as { time?: string; event?: string };
      if (obj.time && new Date(obj.time).getTime() < cutoff) {
        continue;
      }
      const ev = obj.event ?? "unknown";
      counts[ev] = (counts[ev] ?? 0) + 1;
    } catch {
      // ignore
    }
  }
  return counts;
}

// ---------------------------------------------------------------------------
// Cron stats aggregation
// ---------------------------------------------------------------------------

type CronStats = {
  totalRuns: number;
  successRuns: number;
  errorRuns: number;
  skippedRuns: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheWriteTokens: number;
  byJob: Array<{
    jobId: string;
    jobName: string;
    runs: number;
    errors: number;
    inputTokens: number;
    outputTokens: number;
  }>;
};

async function aggregateCronStats(storePath: string, windowMs: number): Promise<CronStats> {
  const cutoff = Date.now() - windowMs;
  const stats: CronStats = {
    totalRuns: 0,
    successRuns: 0,
    errorRuns: 0,
    skippedRuns: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheReadTokens: 0,
    totalCacheWriteTokens: 0,
    byJob: [],
  };

  let jobNameById: Record<string, string> = {};
  try {
    const store = await loadCronStore(storePath);
    jobNameById = Object.fromEntries(store.jobs.map((j) => [j.id, j.name]));
  } catch {
    // no store yet
  }

  let entries: CronRunLogEntry[] = [];
  try {
    const page = await readCronRunLogEntriesPageAll({
      storePath,
      limit: 200,
      offset: 0,
      status: "all",
      sortDir: "asc",
      jobNameById,
    });
    entries = page.entries.filter((e) => e.ts >= cutoff);
  } catch {
    return stats;
  }

  // Group by jobId for per-job breakdown.
  const jobMap = new Map<string, { runs: number; errors: number; inTok: number; outTok: number }>();

  for (const entry of entries) {
    stats.totalRuns++;
    if (entry.status === "ok") {
      stats.successRuns++;
    } else if (entry.status === "error") {
      stats.errorRuns++;
    } else if (entry.status === "skipped") {
      stats.skippedRuns++;
    }

    const inp = entry.usage?.input_tokens ?? 0;
    const outp = entry.usage?.output_tokens ?? 0;
    const cr = entry.usage?.cache_read_tokens ?? 0;
    const cw = entry.usage?.cache_write_tokens ?? 0;
    stats.totalInputTokens += inp;
    stats.totalOutputTokens += outp;
    stats.totalCacheReadTokens += cr;
    stats.totalCacheWriteTokens += cw;

    const jid = entry.jobId;
    if (!jobMap.has(jid)) {
      jobMap.set(jid, { runs: 0, errors: 0, inTok: 0, outTok: 0 });
    }
    const rec = jobMap.get(jid)!;
    rec.runs++;
    if (entry.status === "error") {
      rec.errors++;
    }
    rec.inTok += inp;
    rec.outTok += outp;
  }

  for (const [jobId, rec] of jobMap) {
    stats.byJob.push({
      jobId,
      jobName: jobNameById[jobId] ?? jobId,
      runs: rec.runs,
      errors: rec.errors,
      inputTokens: rec.inTok,
      outputTokens: rec.outTok,
    });
  }
  stats.byJob.sort((a, b) => b.runs - a.runs);

  return stats;
}

// ---------------------------------------------------------------------------
// Main dashboard
// ---------------------------------------------------------------------------

export async function runUsageDashboard(
  options: UsageOptions = {},
  runtime: RuntimeEnv = defaultRuntime,
): Promise<void> {
  const rich = isRich();
  const windowMs = options.windowMs ?? 7 * 24 * 60 * 60_000;
  const windowLabel =
    windowMs >= 86_400_000
      ? `${Math.round(windowMs / 86_400_000)}d`
      : `${Math.round(windowMs / 3_600_000)}h`;

  const storePath = resolveCronStorePath(options.storePath);
  const logDir = resolveLogDir();

  // Fire all async work in parallel.
  const [gatewayUsage, gatewayCost, cronStats, eventCounts, sizes] = await Promise.all([
    callGatewayFromCli("usage.status", options, {}, { progress: false }).catch(() => null),
    callGatewayFromCli("usage.cost", options, {}, { progress: false }).catch(() => null),
    aggregateCronStats(storePath, windowMs),
    countEventLogCalls(logDir, windowMs),
    Promise.all([
      dirSizeBytes(CONFIG_DIR).then((s) => ({ key: "~/.openclaw", size: s })),
      dirSizeBytes(path.join(CONFIG_DIR, "sessions")).then((s) => ({ key: "sessions", size: s })),
      dirSizeBytes(path.join(CONFIG_DIR, "cron")).then((s) => ({ key: "cron store", size: s })),
      dirSizeBytes(path.join(process.cwd(), "data/logs")).then((s) => ({
        key: "event logs",
        size: s,
      })),
    ]),
  ]);

  if (options.json) {
    runtime.log(
      JSON.stringify(
        {
          gatewayUsage,
          gatewayCost,
          cronStats,
          eventCounts,
          sizes: Object.fromEntries(sizes.map(({ key, size }) => [key, size])),
        },
        null,
        2,
      ),
    );
    return;
  }

  runtime.log(colorize(rich, theme.heading, `=== Usage Dashboard (last ${windowLabel}) ===`));

  // ---- Gateway usage (if available) ----
  if (gatewayUsage) {
    runtime.log(colorize(rich, theme.muted, "\n  [Gateway usage]"));
    runtime.log(`  ${JSON.stringify(gatewayUsage).slice(0, 200)}`);
  }
  if (gatewayCost) {
    runtime.log(colorize(rich, theme.muted, "\n  [Gateway cost estimate]"));
    runtime.log(`  ${JSON.stringify(gatewayCost).slice(0, 200)}`);
  }

  // ---- Cron stats ----
  runtime.log(colorize(rich, theme.muted, "\n  [Cron reliability]"));
  const cr = cronStats;
  if (cr.totalRuns === 0) {
    runtime.log(colorize(rich, theme.muted, "    No cron runs in this window."));
  } else {
    const pct = (n: number) => `${((n / cr.totalRuns) * 100).toFixed(0)}%`;
    runtime.log(
      `    runs: ${colorize(rich, theme.info, String(cr.totalRuns))}  ` +
        `ok: ${colorize(rich, theme.success, String(cr.successRuns))} (${pct(cr.successRuns)})  ` +
        `err: ${colorize(rich, theme.error, String(cr.errorRuns))} (${pct(cr.errorRuns)})  ` +
        `skipped: ${colorize(rich, theme.muted, String(cr.skippedRuns))}`,
    );
    const totTok = cr.totalInputTokens + cr.totalOutputTokens;
    if (totTok > 0) {
      runtime.log(
        `    tokens: in=${colorize(rich, theme.info, cr.totalInputTokens.toLocaleString())}  ` +
          `out=${colorize(rich, theme.info, cr.totalOutputTokens.toLocaleString())}  ` +
          `cache-read=${colorize(rich, theme.muted, cr.totalCacheReadTokens.toLocaleString())}`,
      );
    }
    if (cr.byJob.length > 0) {
      runtime.log(colorize(rich, theme.muted, "\n  [Cron jobs]"));
      runtime.log(
        colorize(
          rich,
          theme.muted,
          `    ${"Job".padEnd(24)}  ${"Runs".padStart(5)}  ${"Errors".padStart(6)}  ${"In-tok".padStart(8)}  ${"Out-tok".padStart(8)}`,
        ),
      );
      for (const job of cr.byJob.slice(0, 15)) {
        const errColor = job.errors > 0 ? theme.error : theme.muted;
        runtime.log(
          `    ${colorize(rich, theme.info, job.jobName.slice(0, 24).padEnd(24))}  ` +
            `${String(job.runs).padStart(5)}  ` +
            `${colorize(rich, errColor, String(job.errors).padStart(6))}  ` +
            `${colorize(rich, theme.muted, String(job.inputTokens).padStart(8))}  ` +
            colorize(rich, theme.muted, String(job.outputTokens).padStart(8)),
        );
      }
    }
  }

  // ---- API call counts ----
  const eventTotal = Object.values(eventCounts).reduce((s, n) => s + n, 0);
  if (eventTotal > 0) {
    runtime.log(colorize(rich, theme.muted, `\n  [Event log — ${eventTotal} events]`));
    const sorted = Object.entries(eventCounts)
      .toSorted((a, b) => b[1] - a[1])
      .slice(0, 10);
    for (const [ev, count] of sorted) {
      runtime.log(
        `    ${colorize(rich, theme.accent, ev.padEnd(40))}  ${colorize(rich, theme.info, String(count))}`,
      );
    }
  }

  // ---- Storage sizes ----
  runtime.log(colorize(rich, theme.muted, "\n  [Storage]"));
  for (const { key, size } of sizes) {
    runtime.log(
      `    ${colorize(rich, theme.muted, key.padEnd(20))}  ${colorize(rich, theme.info, formatBytes(size))}`,
    );
  }
}
