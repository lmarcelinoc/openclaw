/**
 * Structured event logging: per-event JSONL files + unified all.jsonl stream.
 *
 * Default log directory is data/logs/ relative to cwd, overridable via
 * OPENCLAW_EVENT_LOG_DIR environment variable.
 */
import fs from "node:fs";
import path from "node:path";
import { redactSensitiveText } from "../logging/redact.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type LogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal";

export type EventLogEntry = {
  /** ISO-8601 timestamp with timezone offset. */
  time: string;
  /** Logical event name, used as the per-event file stem (e.g. "api.request"). */
  event: string;
  level: LogLevel;
  message: string;
  /** Arbitrary structured fields — must be JSON-serialisable. */
  [key: string]: unknown;
};

export type WriteEventOptions = {
  /** Override the log directory for this write. */
  logDir?: string;
  /** Disable secret redaction for this write (default: false). */
  skipRedact?: boolean;
};

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const DEFAULT_LOG_SUBDIR = "data/logs";

export function resolveLogDir(override?: string): string {
  return (
    override ?? process.env.OPENCLAW_EVENT_LOG_DIR ?? path.join(process.cwd(), DEFAULT_LOG_SUBDIR)
  );
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Map of open file descriptors, keyed by absolute path. */
const openFds = new Map<string, number>();

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

function openFd(filePath: string): number {
  const cached = openFds.get(filePath);
  if (cached !== undefined) {
    return cached;
  }
  ensureDir(path.dirname(filePath));
  const fd = fs.openSync(filePath, "a");
  openFds.set(filePath, fd);
  return fd;
}

/** Close all cached file descriptors — call on process exit or in tests. */
export function flushAndCloseAll(): void {
  for (const [p, fd] of openFds) {
    try {
      fs.closeSync(fd);
    } catch {
      // ignore close errors
    }
    openFds.delete(p);
  }
}

function sanitizeEventName(event: string): string {
  // Keep only word chars, dots, and hyphens; collapse sequences; strip leading/trailing dots.
  return (
    event
      .replace(/[^\w.-]/g, "_")
      .replace(/\.{2,}/g, ".")
      .replace(/^[.-]+|[.-]+$/g, "") || "unknown"
  );
}

function isoNow(): string {
  const d = new Date();
  const offset = -d.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const abs = Math.abs(offset);
  const hh = String(Math.floor(abs / 60)).padStart(2, "0");
  const mm = String(abs % 60).padStart(2, "0");
  return `${d.toISOString().slice(0, -1)}${sign}${hh}:${mm}`;
}

function redactEntry(entry: EventLogEntry): EventLogEntry {
  // Redact string values at the top level (message + any string fields).
  const result: EventLogEntry = { ...entry };
  for (const key of Object.keys(result)) {
    const v = result[key];
    if (typeof v === "string") {
      result[key] = redactSensitiveText(v);
    }
  }
  return result;
}

function appendLine(filePath: string, line: string): void {
  try {
    const fd = openFd(filePath);
    fs.writeSync(fd, `${line}\n`);
  } catch {
    // Never throw from logging — fall back to a direct appendFileSync
    try {
      ensureDir(path.dirname(filePath));
      fs.appendFileSync(filePath, `${line}\n`);
    } catch {
      // swallow — logging must never crash the host process
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Write a structured event entry to:
 *   <logDir>/<event_name>.jsonl   — per-event file
 *   <logDir>/all.jsonl            — unified stream (every event mirrored here)
 */
export function writeEvent(
  event: string,
  level: LogLevel,
  message: string,
  fields?: Record<string, unknown>,
  opts?: WriteEventOptions,
): void {
  const logDir = resolveLogDir(opts?.logDir);
  const safeName = sanitizeEventName(event);

  const raw: EventLogEntry = {
    time: isoNow(),
    event: safeName,
    level,
    message,
    ...fields,
  };

  const entry = opts?.skipRedact ? raw : redactEntry(raw);
  const line = JSON.stringify(entry);

  // Write to per-event file
  appendLine(path.join(logDir, `${safeName}.jsonl`), line);

  // Mirror to unified stream
  appendLine(path.join(logDir, "all.jsonl"), line);
}

/** Convenience wrappers for common log levels. */
export const eventLog = {
  trace: (
    event: string,
    message: string,
    fields?: Record<string, unknown>,
    opts?: WriteEventOptions,
  ) => writeEvent(event, "trace", message, fields, opts),
  debug: (
    event: string,
    message: string,
    fields?: Record<string, unknown>,
    opts?: WriteEventOptions,
  ) => writeEvent(event, "debug", message, fields, opts),
  info: (
    event: string,
    message: string,
    fields?: Record<string, unknown>,
    opts?: WriteEventOptions,
  ) => writeEvent(event, "info", message, fields, opts),
  warn: (
    event: string,
    message: string,
    fields?: Record<string, unknown>,
    opts?: WriteEventOptions,
  ) => writeEvent(event, "warn", message, fields, opts),
  error: (
    event: string,
    message: string,
    fields?: Record<string, unknown>,
    opts?: WriteEventOptions,
  ) => writeEvent(event, "error", message, fields, opts),
  fatal: (
    event: string,
    message: string,
    fields?: Record<string, unknown>,
    opts?: WriteEventOptions,
  ) => writeEvent(event, "fatal", message, fields, opts),
} as const;
