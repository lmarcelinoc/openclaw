import {
  readCronRunLogEntriesPage,
  readCronRunLogEntriesPageAll,
  resolveCronRunLogPath,
  type CronRunLogEntry,
  type CronRunLogStatusFilter,
} from "../../cron/run-log.js";
/**
 * Cron history query tool.
 *
 * Reads cron run logs directly from disk and filters by:
 *   - job name or ID
 *   - status (ok / error / skipped)
 *   - time range (--since / --until as ISO or relative like "2h")
 *   - full-text search (--grep)
 *
 * Resolves the cron store path via the Gateway's `cron.status` RPC so it
 * respects whatever the user has configured, with the default as a fallback.
 */
import { loadCronStore, resolveCronStorePath } from "../../cron/store.js";
import type { RuntimeEnv } from "../../runtime.js";
import { defaultRuntime } from "../../runtime.js";
import { colorize, isRich, theme } from "../../terminal/theme.js";

export type CronHistoryOptions = {
  /** Filter to a specific job by name or ID (partial match on name, exact on ID). */
  job?: string;
  /** Status filter. */
  status?: CronRunLogStatusFilter;
  /** Only return entries at or after this time (ms since epoch). */
  sinceMs?: number;
  /** Only return entries at or before this time (ms since epoch). */
  untilMs?: number;
  /** Case-insensitive substring filter across summary/error/jobId. */
  grep?: string;
  /** Max entries to return. */
  limit?: number;
  /** JSON output. */
  json?: boolean;
  /** Cron store path override (defaults to configured or ~/.openclaw/cron/jobs.json). */
  storePath?: string;
};

/** Parse a duration string like "2h", "30m", "1d" into milliseconds. */
function parseDurationMs(input: string): number | null {
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

/** Parse "2h" / ISO-8601 / Unix-ms string into a timestamp (ms). */
export function parseTimeArg(input: string, now = Date.now()): number | null {
  const trimmed = input.trim();
  if (!trimmed) {
    return null;
  }
  // Relative: "2h", "30m", "1d"
  const relMs = parseDurationMs(trimmed);
  if (relMs !== null) {
    return now - relMs;
  }
  // ISO / date string
  const ts = new Date(trimmed).getTime();
  if (Number.isFinite(ts)) {
    return ts;
  }
  // Numeric ms
  const n = Number(trimmed);
  if (Number.isFinite(n) && n > 0) {
    return n;
  }
  return null;
}

function formatTs(ms: number | undefined): string {
  if (!ms) {
    return "-";
  }
  const d = new Date(ms);
  return `${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 19)}Z`;
}

function formatDuration(ms: number | undefined): string {
  if (!ms || ms < 0) {
    return "-";
  }
  if (ms < 1_000) {
    return `${ms}ms`;
  }
  if (ms < 60_000) {
    return `${(ms / 1_000).toFixed(1)}s`;
  }
  return `${(ms / 60_000).toFixed(1)}m`;
}

function padEnd(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 3)}...` : s;
}

export async function runCronHistory(
  options: CronHistoryOptions = {},
  runtime: RuntimeEnv = defaultRuntime,
): Promise<CronRunLogEntry[]> {
  const storePath = resolveCronStorePath(options.storePath);
  const limit = Math.min(200, Math.max(1, options.limit ?? 50));

  // Build a jobId→name map for display and name-based filtering.
  let jobNameById: Record<string, string> = {};
  let targetJobId: string | undefined;
  try {
    const store = await loadCronStore(storePath);
    jobNameById = Object.fromEntries(store.jobs.map((j) => [j.id, j.name]));
    if (options.job) {
      // Prefer exact ID match, then find by name substring.
      const query = options.job.trim().toLowerCase();
      const byId = store.jobs.find((j) => j.id === options.job);
      const byName = store.jobs.find((j) => j.name.toLowerCase().includes(query));
      targetJobId = byId?.id ?? byName?.id;
      if (!targetJobId) {
        runtime.error(`No cron job found matching "${options.job}"`);
        return [];
      }
    }
  } catch {
    // Store may not exist yet; proceed without name resolution.
    if (options.job) {
      // Treat the value as a raw job ID when we can't load the store.
      targetJobId = options.job;
    }
  }

  // When filtering to a single job, use the per-job file reader for efficiency.
  // Otherwise use the all-jobs reader.
  const page = targetJobId
    ? await readCronRunLogEntriesPage(resolveCronRunLogPath({ storePath, jobId: targetJobId }), {
        jobId: targetJobId,
        limit,
        offset: 0,
        status: options.status ?? "all",
        query: options.grep,
        sortDir: "desc",
      })
    : await readCronRunLogEntriesPageAll({
        storePath,
        limit,
        offset: 0,
        status: options.status ?? "all",
        query: options.grep,
        sortDir: "desc",
        jobNameById,
      });

  let entries = page.entries;

  // Time-range filter (applied after pagination since run-log doesn't support it natively).
  if (options.sinceMs !== undefined || options.untilMs !== undefined) {
    entries = entries.filter((e) => {
      if (options.sinceMs !== undefined && e.ts < options.sinceMs) {
        return false;
      }
      if (options.untilMs !== undefined && e.ts > options.untilMs) {
        return false;
      }
      return true;
    });
  }

  if (options.json) {
    runtime.log(JSON.stringify(entries, null, 2));
    return entries;
  }

  if (entries.length === 0) {
    runtime.log("No cron run history found for the given filters.");
    return entries;
  }

  const rich = isRich();

  // Header
  const h = [
    padEnd("Time (UTC)", 20),
    padEnd("Job", 22),
    padEnd("Status", 8),
    padEnd("Duration", 9),
    padEnd("Model", 18),
    "Summary",
  ].join("  ");
  runtime.log(rich ? theme.heading(h) : h);

  for (const entry of entries) {
    const name = truncate(
      (entry as CronRunLogEntry & { jobName?: string }).jobName ??
        jobNameById[entry.jobId] ??
        entry.jobId,
      22,
    );
    const status = entry.status ?? "?";
    const coloredStatus =
      status === "ok"
        ? colorize(rich, theme.success, padEnd(status, 8))
        : status === "error"
          ? colorize(rich, theme.error, padEnd(status, 8))
          : colorize(rich, theme.muted, padEnd(status, 8));
    const model = truncate(entry.model ?? "-", 18);
    const summary = truncate(entry.error ?? entry.summary ?? "-", 60);

    runtime.log(
      [
        colorize(rich, theme.muted, padEnd(formatTs(entry.ts), 20)),
        colorize(rich, theme.info, padEnd(name, 22)),
        coloredStatus,
        colorize(rich, theme.muted, padEnd(formatDuration(entry.durationMs), 9)),
        colorize(rich, theme.accent, padEnd(model, 18)),
        colorize(rich, status === "error" ? theme.error : theme.muted, summary),
      ].join("  "),
    );
  }

  if (page.hasMore) {
    runtime.log(
      colorize(
        rich,
        theme.muted,
        `\n(showing ${entries.length} of ${page.total}+ entries — use --limit to see more)`,
      ),
    );
  } else {
    runtime.log(
      colorize(rich, theme.muted, `\n${entries.length} entr${entries.length === 1 ? "y" : "ies"}`),
    );
  }

  return entries;
}
