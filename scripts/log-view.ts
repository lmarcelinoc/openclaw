#!/usr/bin/env bun
/**
 * log-view.ts — structured event-log viewer
 *
 * Usage:
 *   bun scripts/log-view.ts [options]
 *
 * Options:
 *   --dir <path>         Log directory (default: data/logs or OPENCLAW_EVENT_LOG_DIR)
 *   --event <name>       Filter to entries whose "event" field equals <name>
 *                        (may be repeated; reads <name>.jsonl directly for speed)
 *   --level <lvl>        Minimum level: trace|debug|info|warn|error|fatal
 *   --match <text>       Case-insensitive substring match against the raw JSON line
 *   --from <iso>         Include entries at or after this ISO timestamp
 *   --to   <iso>         Include entries before or at this ISO timestamp
 *   --limit <n>          Stop after emitting <n> matching entries (default: unlimited)
 *   --json               Emit raw JSONL (default: human-readable)
 *   --all                Force reading all.jsonl even when --event is set
 *   --follow             Tail the file(s) and emit new entries as they arrive
 *
 * Examples:
 *   bun scripts/log-view.ts --event api.request --level warn --json
 *   bun scripts/log-view.ts --from 2026-03-08T00:00:00Z --match "timeout"
 *   bun scripts/log-view.ts --event api.request --follow
 */
import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type LogEntry = {
  time?: string;
  event?: string;
  level?: string;
  message?: string;
  [key: string]: unknown;
};

type FilterOpts = {
  events: Set<string>;
  level: string | null;
  match: string | null;
  fromMs: number;
  toMs: number;
  limit: number;
};

const LEVEL_ORDER: Record<string, number> = {
  trace: 0,
  debug: 1,
  info: 2,
  warn: 3,
  error: 4,
  fatal: 5,
};

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]) {
  const args: {
    dir?: string;
    events: string[];
    level?: string;
    match?: string;
    from?: string;
    to?: string;
    limit?: number;
    json: boolean;
    all: boolean;
    follow: boolean;
  } = { events: [], json: false, all: false, follow: false };

  for (let i = 2; i < argv.length; i++) {
    const a = argv[i] ?? "";
    switch (a) {
      case "--dir":
        args.dir = argv[++i];
        break;
      case "--event":
        args.events.push(argv[++i] ?? "");
        break;
      case "--level":
        args.level = argv[++i];
        break;
      case "--match":
        args.match = argv[++i];
        break;
      case "--from":
        args.from = argv[++i];
        break;
      case "--to":
        args.to = argv[++i];
        break;
      case "--limit": {
        const n = Number(argv[++i]);
        if (Number.isFinite(n) && n > 0) {
          args.limit = Math.trunc(n);
        }
        break;
      }
      case "--json":
        args.json = true;
        break;
      case "--all":
        args.all = true;
        break;
      case "--follow":
        args.follow = true;
        break;
      case "--help":
      case "-h":
        printHelp();
        process.exit(0);
        break;
    }
  }
  return args;
}

function printHelp() {
  process.stdout.write(
    [
      "log-view.ts — structured event-log viewer",
      "",
      "Usage: bun scripts/log-view.ts [options]",
      "",
      "  --dir <path>    Log directory (default: data/logs or OPENCLAW_EVENT_LOG_DIR)",
      "  --event <name>  Filter by event name (repeatable)",
      "  --level <lvl>   Minimum level: trace|debug|info|warn|error|fatal",
      "  --match <text>  Substring match against raw JSON line",
      "  --from <iso>    Entries at or after this timestamp",
      "  --to   <iso>    Entries at or before this timestamp",
      "  --limit <n>     Stop after n matching entries",
      "  --json          Emit raw JSONL (default: human-readable)",
      "  --all           Force reading all.jsonl even when --event is set",
      "  --follow        Tail and stream new entries as they appear",
      "  -h, --help      Show this help",
      "",
    ].join("\n"),
  );
}

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

function passes(raw: string, entry: LogEntry, opts: FilterOpts): boolean {
  // Level filter
  if (opts.level !== null) {
    const entryOrd = LEVEL_ORDER[entry.level ?? ""] ?? -1;
    const minOrd = LEVEL_ORDER[opts.level] ?? 0;
    if (entryOrd < minOrd) {
      return false;
    }
  }

  // Event filter (only when reading all.jsonl)
  if (opts.events.size > 0 && !opts.events.has(entry.event ?? "")) {
    return false;
  }

  // Substring match
  if (opts.match !== null && !raw.toLowerCase().includes(opts.match.toLowerCase())) {
    return false;
  }

  // Time range
  if (entry.time) {
    const ms = Date.parse(entry.time);
    if (Number.isFinite(ms)) {
      if (opts.fromMs > 0 && ms < opts.fromMs) {
        return false;
      }
      if (opts.toMs > 0 && ms > opts.toMs) {
        return false;
      }
    }
  }

  return true;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

const LEVEL_COLOR: Record<string, string> = {
  fatal: "\x1b[35m",
  error: "\x1b[31m",
  warn: "\x1b[33m",
  info: "\x1b[36m",
  debug: "\x1b[90m",
  trace: "\x1b[90m",
};
const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";

const isTTY = Boolean(process.stdout.isTTY);

function c(code: string, text: string) {
  return isTTY ? `${code}${text}${RESET}` : text;
}

function formatHuman(entry: LogEntry, raw: string): string {
  const time = entry.time ? c(DIM, entry.time.slice(0, 19).replace("T", " ")) : "";
  const lvl = entry.level
    ? c(LEVEL_COLOR[entry.level] ?? "", entry.level.toUpperCase().padEnd(5))
    : "     ";
  const evt = entry.event ? c(BOLD, entry.event) : "";
  const msg = entry.message ?? raw;

  const rest: Record<string, unknown> = {};
  for (const k of Object.keys(entry)) {
    if (k !== "time" && k !== "level" && k !== "event" && k !== "message") {
      rest[k] = entry[k];
    }
  }
  const extra = Object.keys(rest).length > 0 ? c(DIM, " " + JSON.stringify(rest)) : "";
  return [time, lvl, evt, msg + extra].filter(Boolean).join(" ");
}

// ---------------------------------------------------------------------------
// Reading JSONL
// ---------------------------------------------------------------------------

function safeParse(line: string): LogEntry | null {
  try {
    const obj = JSON.parse(line) as unknown;
    if (obj && typeof obj === "object" && !Array.isArray(obj)) {
      return obj as LogEntry;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Read a JSONL file line-by-line, emit matching entries, and return how many
 * were emitted. Stops early when limit is reached (returns `limit` from caller).
 */
function readFile(
  filePath: string,
  opts: FilterOpts,
  emitJson: boolean,
  emitted: { count: number },
): void {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    return; // file may not exist yet
  }

  const lines = raw.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    const entry = safeParse(trimmed);
    if (!entry) {
      continue;
    }
    if (!passes(trimmed, entry, opts)) {
      continue;
    }
    const out = emitJson ? trimmed : formatHuman(entry, trimmed);
    process.stdout.write(`${out}\n`);
    emitted.count++;
    if (opts.limit > 0 && emitted.count >= opts.limit) {
      return;
    }
  }
}

// ---------------------------------------------------------------------------
// Follow (tail) support
// ---------------------------------------------------------------------------

async function followFile(
  filePath: string,
  opts: FilterOpts,
  emitJson: boolean,
  intervalMs = 500,
): Promise<void> {
  let position = 0;
  // Start at end of file so we only see new entries
  try {
    position = fs.statSync(filePath).size;
  } catch {
    // file doesn't exist yet — start at 0
  }

  // Watch for new data
  while (true) {
    try {
      const stat = fs.statSync(filePath);
      if (stat.size < position) {
        // File was rotated/truncated — reset
        position = 0;
      }
      if (stat.size > position) {
        const fd = fs.openSync(filePath, "r");
        const buf = Buffer.alloc(stat.size - position);
        fs.readSync(fd, buf, 0, buf.length, position);
        fs.closeSync(fd);
        position = stat.size;
        const chunk = buf.toString("utf8");
        for (const line of chunk.split("\n")) {
          const trimmed = line.trim();
          if (!trimmed) {
            continue;
          }
          const entry = safeParse(trimmed);
          if (!entry || !passes(trimmed, entry, opts)) {
            continue;
          }
          const out = emitJson ? trimmed : formatHuman(entry, trimmed);
          process.stdout.write(`${out}\n`);
        }
      }
    } catch {
      // file disappeared mid-tail; retry next tick
    }
    await delay(intervalMs);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv);

  const logDir =
    args.dir ?? process.env.OPENCLAW_EVENT_LOG_DIR ?? path.join(process.cwd(), "data/logs");

  const opts: FilterOpts = {
    events: new Set(args.events.filter(Boolean)),
    level: args.level ?? null,
    match: args.match ?? null,
    fromMs: args.from ? Date.parse(args.from) : 0,
    toMs: args.to ? Date.parse(args.to) : 0,
    limit: args.limit ?? 0,
  };

  if (opts.fromMs && !Number.isFinite(opts.fromMs)) {
    process.stderr.write(`Invalid --from value: ${args.from}\n`);
    process.exit(2);
  }
  if (opts.toMs && !Number.isFinite(opts.toMs)) {
    process.stderr.write(`Invalid --to value: ${args.to}\n`);
    process.exit(2);
  }

  // Decide which files to read:
  //  - specific event files when --event given (faster) unless --all
  //  - all.jsonl otherwise
  let filesToRead: string[];
  if (opts.events.size > 0 && !args.all) {
    filesToRead = [...opts.events].map((e) =>
      path.join(logDir, `${e.replace(/[^\w.-]/g, "_")}.jsonl`),
    );
    // When reading per-event files we don't need the event filter anymore
    opts.events = new Set();
  } else {
    filesToRead = [path.join(logDir, "all.jsonl")];
  }

  if (args.follow) {
    // Follow mode: read existing entries from first file, then tail it
    const followPath = filesToRead[0] ?? path.join(logDir, "all.jsonl");
    const emitted = { count: 0 };
    readFile(followPath, opts, args.json, emitted);
    await followFile(followPath, opts, args.json);
    return;
  }

  const emitted = { count: 0 };
  for (const file of filesToRead) {
    readFile(file, opts, args.json, emitted);
    if (opts.limit > 0 && emitted.count >= opts.limit) {
      break;
    }
  }
}

main().catch((err) => {
  process.stderr.write(`log-view: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
