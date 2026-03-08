#!/usr/bin/env bun
/**
 * log-ingest.ts — nightly JSONL + server-log ingest into SQLite
 *
 * Reads every *.jsonl under the event-log directory and ingests rows into
 * a SQLite database. Raw gateway log files (openclaw-YYYY-MM-DD.log) are
 * ingested into a separate `server_logs` table.  Both tables deduplicate on
 * insert, so the script is safe to run multiple times on overlapping files
 * (e.g. rotated logs that share some lines).
 *
 * Usage:
 *   bun scripts/log-ingest.ts [options]
 *
 * Options:
 *   --log-dir  <path>   Event-log JSONL directory (default: data/logs)
 *   --raw-dir  <path>   Raw gateway log directory (default: ~/.openclaw/tmp or
 *                       OPENCLAW_LOG_DIR env var)
 *   --db       <path>   Output SQLite database (default: data/logs/structured.db)
 *   --dry-run           Parse and count rows without writing to DB
 *   --verbose           Print progress information
 *
 * Tables created:
 *   structured_logs  — parsed event-log entries from *.jsonl files
 *   server_logs      — parsed raw gateway log lines
 */
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

// ---------------------------------------------------------------------------
// SQLite shim (same pattern as src/memory/sqlite.ts)
// ---------------------------------------------------------------------------

type SqliteDB = {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
};

type SqliteStatement = {
  run(...args: unknown[]): { changes: number };
  all(...args: unknown[]): unknown[];
};

function openSqlite(dbPath: string): SqliteDB {
  const require = createRequire(import.meta.url);

  // Try bun:sqlite first (faster, no --experimental flag needed)
  if (typeof Bun !== "undefined") {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { Database } = require("bun:sqlite");
      return new Database(dbPath) as SqliteDB;
    } catch {
      // fall through to node:sqlite
    }
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { DatabaseSync } = require("node:sqlite");
    return new DatabaseSync(dbPath) as SqliteDB;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`SQLite unavailable (tried bun:sqlite and node:sqlite). ${msg}`, {
      cause: err,
    });
  }
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const SCHEMA_STRUCTURED = `
CREATE TABLE IF NOT EXISTS structured_logs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  row_hash    TEXT    NOT NULL UNIQUE,   -- SHA-256-hex of the raw line for dedup
  source_file TEXT    NOT NULL,
  time        TEXT,
  event       TEXT,
  level       TEXT,
  message     TEXT,
  extra_json  TEXT                       -- remaining fields as JSON object
);
CREATE INDEX IF NOT EXISTS idx_sl_time   ON structured_logs(time);
CREATE INDEX IF NOT EXISTS idx_sl_event  ON structured_logs(event);
CREATE INDEX IF NOT EXISTS idx_sl_level  ON structured_logs(level);
`;

const SCHEMA_SERVER = `
CREATE TABLE IF NOT EXISTS server_logs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  row_hash    TEXT    NOT NULL UNIQUE,
  source_file TEXT    NOT NULL,
  time        TEXT,
  level       TEXT,
  subsystem   TEXT,
  message     TEXT,
  raw_line    TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_srvl_time      ON server_logs(time);
CREATE INDEX IF NOT EXISTS idx_srvl_level     ON server_logs(level);
CREATE INDEX IF NOT EXISTS idx_srvl_subsystem ON server_logs(subsystem);
`;

// ---------------------------------------------------------------------------
// Hashing (lightweight FNV-1a for dedup — no crypto dependency)
// ---------------------------------------------------------------------------

function hashLine(line: string): string {
  // FNV-1a 64-bit (simulated via two 32-bit halves) encoded as hex.
  let h1 = 0x811c9dc5 >>> 0;
  let h2 = 0xd86d0f93 >>> 0;
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x01000193) >>> 0;
  }
  return h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0");
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]) {
  const args: {
    logDir?: string;
    rawDir?: string;
    db?: string;
    dryRun: boolean;
    verbose: boolean;
  } = { dryRun: false, verbose: false };

  for (let i = 2; i < argv.length; i++) {
    const a = argv[i] ?? "";
    switch (a) {
      case "--log-dir":
        args.logDir = argv[++i];
        break;
      case "--raw-dir":
        args.rawDir = argv[++i];
        break;
      case "--db":
        args.db = argv[++i];
        break;
      case "--dry-run":
        args.dryRun = true;
        break;
      case "--verbose":
        args.verbose = true;
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
      "log-ingest.ts — ingest JSONL event logs + raw server logs into SQLite",
      "",
      "  --log-dir <path>  JSONL event log directory (default: data/logs)",
      "  --raw-dir <path>  Raw gateway log directory",
      "  --db      <path>  SQLite output path (default: data/logs/structured.db)",
      "  --dry-run         Parse without writing",
      "  --verbose         Print progress",
      "",
    ].join("\n"),
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function log(verbose: boolean, msg: string) {
  if (verbose) {
    process.stderr.write(`[log-ingest] ${msg}\n`);
  }
}

function listFiles(dir: string, ext: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith(ext))
      .map((e) => path.join(dir, e.name))
      .toSorted();
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Structured-log ingest
// ---------------------------------------------------------------------------

type StructuredInsertRow = {
  row_hash: string;
  source_file: string;
  time: string | null;
  event: string | null;
  level: string | null;
  message: string | null;
  extra_json: string | null;
};

function parseJsonlEntry(line: string, sourceFile: string): StructuredInsertRow | null {
  try {
    const obj = JSON.parse(line) as Record<string, unknown>;
    if (!obj || typeof obj !== "object") {
      return null;
    }

    const { time, event, level, message, ...rest } = obj;
    return {
      row_hash: hashLine(line),
      source_file: sourceFile,
      time: typeof time === "string" ? time : null,
      event: typeof event === "string" ? event : null,
      level: typeof level === "string" ? level : null,
      message: typeof message === "string" ? message : null,
      extra_json: Object.keys(rest).length > 0 ? JSON.stringify(rest) : null,
    };
  } catch {
    return null;
  }
}

function ingestJsonlFile(
  db: SqliteDB,
  filePath: string,
  dryRun: boolean,
  verbose: boolean,
): { parsed: number; inserted: number } {
  const content = fs.readFileSync(filePath, "utf8");
  const lines = content.split("\n");
  const stmt = dryRun
    ? null
    : db.prepare(
        `INSERT OR IGNORE INTO structured_logs
         (row_hash, source_file, time, event, level, message, extra_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );

  let parsed = 0;
  let inserted = 0;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      continue;
    }
    const row = parseJsonlEntry(line, filePath);
    if (!row) {
      continue;
    }
    parsed++;
    if (stmt) {
      const result = stmt.run(
        row.row_hash,
        row.source_file,
        row.time,
        row.event,
        row.level,
        row.message,
        row.extra_json,
      );
      if (result.changes > 0) {
        inserted++;
      }
    } else {
      inserted++; // dry-run: count as inserted
    }
  }

  log(verbose, `  ${path.basename(filePath)}: parsed=${parsed} inserted=${inserted}`);
  return { parsed, inserted };
}

// ---------------------------------------------------------------------------
// Server-log ingest
// ---------------------------------------------------------------------------

// Raw gateway logs are JSON-per-line (same format written by src/logging/logger.ts).
// Non-JSON lines are stored verbatim in raw_line with nulls for parsed fields.

type ServerLogRow = {
  row_hash: string;
  source_file: string;
  time: string | null;
  level: string | null;
  subsystem: string | null;
  message: string | null;
  raw_line: string;
};

function parseServerLogLine(line: string, sourceFile: string): ServerLogRow {
  const base: ServerLogRow = {
    row_hash: hashLine(line),
    source_file: sourceFile,
    time: null,
    level: null,
    subsystem: null,
    message: null,
    raw_line: line,
  };
  try {
    const obj = JSON.parse(line) as Record<string, unknown>;
    if (!obj || typeof obj !== "object") {
      return base;
    }
    return {
      ...base,
      time: typeof obj.time === "string" ? obj.time : null,
      level:
        typeof obj.level === "string"
          ? obj.level
          : typeof obj._meta === "object" && obj._meta !== null
            ? (((obj._meta as Record<string, unknown>).logLevelName as string | null | undefined) ??
              "")
            : null,
      subsystem:
        typeof obj.subsystem === "string"
          ? obj.subsystem
          : typeof obj.module === "string"
            ? obj.module
            : null,
      message:
        typeof obj.message === "string"
          ? obj.message
          : typeof obj.msg === "string"
            ? obj.msg
            : null,
    };
  } catch {
    return base;
  }
}

function ingestServerLogFile(
  db: SqliteDB,
  filePath: string,
  dryRun: boolean,
  verbose: boolean,
): { parsed: number; inserted: number } {
  const content = fs.readFileSync(filePath, "utf8");
  const lines = content.split("\n");
  const stmt = dryRun
    ? null
    : db.prepare(
        `INSERT OR IGNORE INTO server_logs
         (row_hash, source_file, time, level, subsystem, message, raw_line)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );

  let parsed = 0;
  let inserted = 0;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      continue;
    }
    parsed++;
    const row = parseServerLogLine(line, filePath);
    if (stmt) {
      const result = stmt.run(
        row.row_hash,
        row.source_file,
        row.time,
        row.level,
        row.subsystem,
        row.message,
        row.raw_line,
      );
      if (result.changes > 0) {
        inserted++;
      }
    } else {
      inserted++;
    }
  }

  log(verbose, `  ${path.basename(filePath)}: parsed=${parsed} inserted=${inserted}`);
  return { parsed, inserted };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv);

  const logDir =
    args.logDir ?? process.env.OPENCLAW_EVENT_LOG_DIR ?? path.join(process.cwd(), "data/logs");

  const rawDir = args.rawDir ?? process.env.OPENCLAW_LOG_DIR ?? path.join(os.tmpdir(), "openclaw");

  const dbPath = args.db ?? path.join(logDir, "structured.db");

  log(args.verbose, `logDir  = ${logDir}`);
  log(args.verbose, `rawDir  = ${rawDir}`);
  log(args.verbose, `db      = ${dbPath}`);
  log(args.verbose, `dry-run = ${args.dryRun}`);

  // Open or create the database
  let db: SqliteDB | null = null;
  if (!args.dryRun) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    db = openSqlite(dbPath);
    db.exec(SCHEMA_STRUCTURED);
    db.exec(SCHEMA_SERVER);
  }

  let totalStructParsed = 0;
  let totalStructInserted = 0;
  let totalServerParsed = 0;
  let totalServerInserted = 0;

  // Ingest event-log JSONL files (skip all.jsonl and skip the DB file itself)
  const jsonlFiles = listFiles(logDir, ".jsonl").filter((f) => path.basename(f) !== "all.jsonl");
  log(args.verbose, `Found ${jsonlFiles.length} per-event JSONL files`);
  for (const f of jsonlFiles) {
    const { parsed, inserted } = ingestJsonlFile(
      db ?? ({} as SqliteDB), // dummy for dry-run
      f,
      args.dryRun,
      args.verbose,
    );
    totalStructParsed += parsed;
    totalStructInserted += inserted;
  }

  // Also ingest all.jsonl if it exists (safe: hashes deduplicate)
  const allJsonl = path.join(logDir, "all.jsonl");
  if (fs.existsSync(allJsonl)) {
    log(args.verbose, "Ingesting all.jsonl");
    const { parsed, inserted } = ingestJsonlFile(
      db ?? ({} as SqliteDB),
      allJsonl,
      args.dryRun,
      args.verbose,
    );
    totalStructParsed += parsed;
    totalStructInserted += inserted;
  }

  // Ingest raw server log files
  const rawFiles = listFiles(rawDir, ".log");
  log(args.verbose, `Found ${rawFiles.length} raw server log files`);
  for (const f of rawFiles) {
    const { parsed, inserted } = ingestServerLogFile(
      db ?? ({} as SqliteDB),
      f,
      args.dryRun,
      args.verbose,
    );
    totalServerParsed += parsed;
    totalServerInserted += inserted;
  }

  if (db) {
    db.close();
  }

  process.stdout.write(
    JSON.stringify({
      dryRun: args.dryRun,
      structured: { parsed: totalStructParsed, inserted: totalStructInserted },
      server: { parsed: totalServerParsed, inserted: totalServerInserted },
    }) + "\n",
  );
}

main().catch((err) => {
  process.stderr.write(`log-ingest: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
