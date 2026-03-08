import { readCronRunLogEntriesPageAll, type CronRunLogEntry } from "../../cron/run-log.js";
/**
 * Persistent failure detector for cron jobs.
 *
 * A job is "persistently failing" when it has ≥3 errors within any
 * rolling 6-hour window.  This distinguishes genuinely broken jobs
 * from one-off transient failures.
 */
import { loadCronStore, resolveCronStorePath } from "../../cron/store.js";
import type { RuntimeEnv } from "../../runtime.js";
import { defaultRuntime } from "../../runtime.js";
import { colorize, isRich, theme } from "../../terminal/theme.js";

export type CronFailureOptions = {
  /** Number of failures within the window to trigger a flag. Default: 3. */
  threshold?: number;
  /** Rolling window in ms. Default: 6 hours. */
  windowMs?: number;
  /** JSON output. */
  json?: boolean;
  /** Cron store path override. */
  storePath?: string;
};

export type PersistentlyFailingJob = {
  jobId: string;
  jobName: string;
  failCount: number;
  windowMs: number;
  oldestFailureMs: number;
  newestFailureMs: number;
  lastError?: string;
  entries: CronRunLogEntry[];
};

export async function detectCronFailures(
  options: CronFailureOptions = {},
  runtime: RuntimeEnv = defaultRuntime,
): Promise<PersistentlyFailingJob[]> {
  const threshold = options.threshold ?? 3;
  const windowMs = options.windowMs ?? 6 * 60 * 60_000;
  const storePath = resolveCronStorePath(options.storePath);
  const cutoffMs = Date.now() - windowMs;

  // Load job name map.
  let jobNameById: Record<string, string> = {};
  try {
    const store = await loadCronStore(storePath);
    jobNameById = Object.fromEntries(store.jobs.map((j) => [j.id, j.name]));
  } catch {
    // Proceed without names.
  }

  // Read all error entries in the window (up to 500 per job, across all jobs).
  const page = await readCronRunLogEntriesPageAll({
    storePath,
    limit: 200,
    offset: 0,
    status: "error",
    sortDir: "asc",
    jobNameById,
  });

  // Group by jobId, filter to window.
  const byJob = new Map<string, CronRunLogEntry[]>();
  for (const entry of page.entries) {
    if (entry.ts < cutoffMs) {
      continue;
    }
    if (!byJob.has(entry.jobId)) {
      byJob.set(entry.jobId, []);
    }
    byJob.get(entry.jobId)!.push(entry);
  }

  const flagged: PersistentlyFailingJob[] = [];
  for (const [jobId, entries] of byJob) {
    if (entries.length < threshold) {
      continue;
    }
    const sorted = entries.toSorted((a, b) => a.ts - b.ts);
    flagged.push({
      jobId,
      jobName: jobNameById[jobId] ?? jobId,
      failCount: entries.length,
      windowMs,
      oldestFailureMs: sorted[0]?.ts ?? 0,
      newestFailureMs: sorted[sorted.length - 1]?.ts ?? 0,
      lastError: sorted[sorted.length - 1]?.error,
      entries: sorted,
    });
  }

  if (options.json) {
    runtime.log(JSON.stringify(flagged, null, 2));
    return flagged;
  }

  const rich = isRich();

  if (flagged.length === 0) {
    runtime.log(
      colorize(
        rich,
        theme.success,
        `No persistent failures in the last ${Math.round(windowMs / 3_600_000)}h.`,
      ),
    );
    return flagged;
  }

  runtime.log(
    colorize(
      rich,
      theme.error,
      `${flagged.length} job(s) have ${threshold}+ failures in the last ${Math.round(windowMs / 3_600_000)}h:`,
    ),
  );

  for (const job of flagged) {
    const firstAt = new Date(job.oldestFailureMs).toISOString().slice(0, 19) + "Z";
    const lastAt = new Date(job.newestFailureMs).toISOString().slice(0, 19) + "Z";
    runtime.log(
      [
        `\n  ${colorize(rich, theme.error, "●")} ${colorize(rich, theme.info, job.jobName)}`,
        `    ${colorize(rich, theme.muted, `id:`)} ${job.jobId}`,
        `    ${colorize(rich, theme.muted, "failures:")} ${colorize(rich, theme.error, String(job.failCount))}  (first ${firstAt}, last ${lastAt})`,
        job.lastError
          ? `    ${colorize(rich, theme.muted, "last error:")} ${colorize(rich, theme.error, job.lastError.slice(0, 120))}`
          : "",
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }

  return flagged;
}
