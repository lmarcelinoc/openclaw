/**
 * Unified event-log viewer.
 *
 * Reads from <logDir>/all.jsonl (or a per-event file) and supports:
 *   --event     filter by event name (exact or prefix)
 *   --level     filter by log level (trace/debug/info/warn/error/fatal)
 *   --grep      case-insensitive substring across the full line
 *   --since     ISO date, Unix-ms, or relative ("1h", "30m")
 *   --until     same
 *   --limit     max lines (default 100)
 *   --json      emit raw JSONL
 *
 * Quick-access aliases:
 *   --errors    errors/fatals in the last 1 hour
 *   --recent    all levels in the last 15 minutes
 */
import fs from "node:fs/promises";
import path from "node:path";
import { resolveLogDir } from "../../event-log/writer.js";
import type { LogLevel } from "../../event-log/writer.js";
import type { RuntimeEnv } from "../../runtime.js";
import { defaultRuntime } from "../../runtime.js";
import { colorize, isRich, theme } from "../../terminal/theme.js";

export type LogViewOptions = {
  /** Filter by event name (exact or "prefix.*" style). */
  event?: string;
  /** Filter by minimum log level (or exact level). */
  level?: LogLevel;
  /** Case-insensitive substring filter. */
  grep?: string;
  /** Start time (ISO/relative/ms). */
  sinceMs?: number;
  /** End time. */
  untilMs?: number;
  /** Max entries. Default: 100. */
  limit?: number;
  /** Raw JSONL output instead of formatted table. */
  json?: boolean;
  /** Alias: errors+fatals in the last hour. */
  errors?: boolean;
  /** Alias: all levels in the last 15 min. */
  recent?: boolean;
  /** Override for event log directory. */
  logDir?: string;
};

type LogEntry = {
  time?: string;
  event?: string;
  level?: string;
  message?: string;
  [key: string]: unknown;
};

const LEVEL_ORDER: Record<string, number> = {
  trace: 0,
  debug: 1,
  info: 2,
  warn: 3,
  error: 4,
  fatal: 5,
};

function levelAtLeast(entry: string | undefined, min: string): boolean {
  return (LEVEL_ORDER[entry ?? ""] ?? -1) >= (LEVEL_ORDER[min] ?? 0);
}

function colorForLevel(rich: boolean, level: string | undefined): (s: string) => string {
  if (!rich) {
    return (s) => s;
  }
  switch (level) {
    case "fatal":
    case "error":
      return (s) => theme.error(s);
    case "warn":
      return (s) => theme.warn(s);
    case "info":
      return (s) => theme.info(s);
    case "debug":
    case "trace":
      return (s) => theme.muted(s);
    default:
      return (s) => s;
  }
}

function matchesEvent(entry: LogEntry, filter: string): boolean {
  const ev = entry.event ?? "";
  // Support "prefix.*" glob: strip the ".*" and check prefix.
  const prefix = filter.endsWith(".*") ? filter.slice(0, -2) : null;
  if (prefix !== null) {
    return ev.startsWith(prefix);
  }
  return ev === filter || ev.startsWith(filter + ".");
}

function extraFields(entry: LogEntry): string {
  const skip = new Set(["time", "event", "level", "message"]);
  const parts: string[] = [];
  for (const [k, v] of Object.entries(entry)) {
    if (skip.has(k)) {
      continue;
    }
    parts.push(`${k}=${JSON.stringify(v)}`);
  }
  return parts.join(" ");
}

export async function runLogView(
  options: LogViewOptions = {},
  runtime: RuntimeEnv = defaultRuntime,
): Promise<LogEntry[]> {
  const logDir = resolveLogDir(options.logDir);

  // Apply quick-access alias defaults.
  const now = Date.now();
  let sinceMs = options.sinceMs;
  let untilMs = options.untilMs;
  let minLevel = options.level;

  if (options.errors) {
    sinceMs = sinceMs ?? now - 60 * 60_000;
    minLevel = minLevel ?? "error";
  }
  if (options.recent) {
    sinceMs = sinceMs ?? now - 15 * 60_000;
  }

  const limit = Math.min(2_000, Math.max(1, options.limit ?? 100));

  // Decide which file to read.
  const filePath = options.event
    ? path.join(logDir, `${options.event.replace(/\.\*/g, "")}.jsonl`)
    : path.join(logDir, "all.jsonl");

  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf-8");
  } catch {
    if (options.event) {
      runtime.error(`No log file for event "${options.event}" at ${filePath}`);
    } else {
      runtime.error(`Event log not found at ${filePath}`);
    }
    return [];
  }

  const lines = raw.split("\n").filter(Boolean);

  // Parse and filter (scan from end for recency).
  const matched: LogEntry[] = [];
  const grep = options.grep?.toLowerCase();

  for (let i = lines.length - 1; i >= 0 && matched.length < limit; i--) {
    const line = lines[i];
    let entry: LogEntry;
    try {
      entry = JSON.parse(line) as LogEntry;
    } catch {
      continue;
    }

    // Time filters
    if (sinceMs !== undefined || untilMs !== undefined) {
      const ts = entry.time ? new Date(entry.time).getTime() : NaN;
      if (sinceMs !== undefined && ts < sinceMs) {
        continue;
      }
      if (untilMs !== undefined && ts > untilMs) {
        continue;
      }
    }

    // Event filter
    if (options.event && !matchesEvent(entry, options.event)) {
      continue;
    }

    // Level filter
    if (minLevel && !levelAtLeast(entry.level, minLevel)) {
      continue;
    }

    // Grep filter
    if (grep && !line.toLowerCase().includes(grep)) {
      continue;
    }

    matched.push(entry);
  }

  // Restore chronological order (we scanned newest-first).
  matched.reverse();

  if (options.json) {
    for (const entry of matched) {
      runtime.log(JSON.stringify(entry));
    }
    return matched;
  }

  if (matched.length === 0) {
    runtime.log("No matching log entries.");
    return matched;
  }

  const rich = isRich();

  for (const entry of matched) {
    const time = (entry.time ?? "").slice(0, 23).padEnd(23);
    const level = (entry.level ?? "?").padEnd(5);
    const event = (entry.event ?? "").padEnd(28);
    const msg = entry.message ?? "";
    const extra = extraFields(entry);
    const color = colorForLevel(rich, entry.level);

    runtime.log(
      [
        colorize(rich, theme.muted, time),
        color(level),
        colorize(rich, theme.accent, event),
        color(msg),
        extra ? colorize(rich, theme.muted, extra) : "",
      ]
        .filter(Boolean)
        .join("  "),
    );
  }

  runtime.log(
    colorize(
      rich,
      theme.muted,
      `\n${matched.length} entr${matched.length === 1 ? "y" : "ies"}${limit === matched.length ? ` (limit ${limit})` : ""}`,
    ),
  );

  return matched;
}
