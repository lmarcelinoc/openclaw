#!/usr/bin/env bun
/**
 * log-rotate.ts — daily JSONL log rotation + monthly SQLite archiving
 *
 * Run this as a daily cron job (e.g. via `openclaw cron`).
 *
 * What it does
 * ────────────
 * 1. For each *.jsonl file exceeding the size threshold (default 50 MB):
 *    - Move the current file to <name>.<datestamp>.jsonl.gz (gzip-compressed)
 *    - Create a fresh empty <name>.jsonl
 *    - Keep at most <keep> rotated archives per event name (prune oldest)
 *
 * 2. For all.jsonl, apply the same size-based rotation.
 *
 * 3. Monthly DB archiving (when --archive-db is set):
 *    - Open the main structured.db
 *    - For each calendar month that has rows older than the current month,
 *      copy those rows into a separate data/logs/archive/YYYY-MM.db
 *    - Delete the archived rows from the main DB (keeps the main DB lean)
 *
 * Usage:
 *   bun scripts/log-rotate.ts [options]
 *
 * Options:
 *   --dir        <path>    Log directory (default: data/logs)
 *   --threshold  <bytes>   Rotate when file exceeds this size (default: 52428800 = 50 MB)
 *   --keep       <n>       Number of rotated archives to retain per event (default: 3)
 *   --archive-db           Also archive old SQLite rows into monthly databases
 *   --db         <path>    Main structured DB (default: <dir>/structured.db)
 *   --dry-run              Show what would happen without making changes
 *   --verbose              Print progress to stderr
 */
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import zlib from "node:zlib";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type RotateOptions = {
  dir: string;
  threshold: number;
  keep: number;
  archiveDb: boolean;
  dbPath: string;
  dryRun: boolean;
  verbose: boolean;
};

// ---------------------------------------------------------------------------
// SQLite shim (same pattern as log-ingest.ts)
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
  if (typeof Bun !== "undefined") {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { Database } = require("bun:sqlite");
      return new Database(dbPath) as SqliteDB;
    } catch {
      /* fall through */
    }
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { DatabaseSync } = require("node:sqlite");
  return new DatabaseSync(dbPath) as SqliteDB;
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

const DEFAULT_THRESHOLD = 50 * 1024 * 1024; // 50 MB
const DEFAULT_KEEP = 3;

function parseArgs(argv: string[]): RotateOptions {
  const args: RotateOptions = {
    dir: "",
    threshold: DEFAULT_THRESHOLD,
    keep: DEFAULT_KEEP,
    archiveDb: false,
    dbPath: "",
    dryRun: false,
    verbose: false,
  };

  for (let i = 2; i < argv.length; i++) {
    const a = argv[i] ?? "";
    switch (a) {
      case "--dir":
        args.dir = argv[++i] ?? "";
        break;
      case "--threshold": {
        const n = Number(argv[++i]);
        if (Number.isFinite(n) && n > 0) {
          args.threshold = Math.trunc(n);
        }
        break;
      }
      case "--keep": {
        const n = Number(argv[++i]);
        if (Number.isFinite(n) && n >= 0) {
          args.keep = Math.trunc(n);
        }
        break;
      }
      case "--archive-db":
        args.archiveDb = true;
        break;
      case "--db":
        args.dbPath = argv[++i] ?? "";
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

  if (!args.dir) {
    args.dir = process.env.OPENCLAW_EVENT_LOG_DIR ?? path.join(process.cwd(), "data/logs");
  }
  if (!args.dbPath) {
    args.dbPath = path.join(args.dir, "structured.db");
  }

  return args;
}

function printHelp() {
  process.stdout.write(
    [
      "log-rotate.ts — rotate JSONL logs and archive old SQLite rows",
      "",
      "  --dir       <path>   Log directory (default: data/logs)",
      "  --threshold <bytes>  Rotate when file exceeds this size (default: 52428800)",
      "  --keep      <n>      Rotated archives to keep per event name (default: 3)",
      "  --archive-db         Archive old rows into monthly SQLite DBs",
      "  --db        <path>   Main structured DB (default: <dir>/structured.db)",
      "  --dry-run            Show actions without executing",
      "  --verbose            Print progress",
      "",
    ].join("\n"),
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function vlog(opts: RotateOptions, msg: string) {
  if (opts.verbose) {
    process.stderr.write(`[log-rotate] ${msg}\n`);
  }
}

function datestamp(): string {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

function gzipSync(input: Buffer): Buffer {
  return zlib.gzipSync(input, { level: 6 });
}

// ---------------------------------------------------------------------------
// JSONL rotation
// ---------------------------------------------------------------------------

type RotateSummary = {
  file: string;
  sizeBefore: number;
  archivePath: string;
  pruned: string[];
  skipped: boolean;
};

/**
 * Returns all rotated archives for a given base name, sorted oldest-first.
 * Archives look like: <stem>.<YYYY-MM-DD>[.<n>].jsonl.gz
 */
function listArchives(dir: string, stem: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.startsWith(`${stem}.`) && e.name.endsWith(".jsonl.gz"))
      .map((e) => path.join(dir, e.name))
      .toSorted(); // lexicographic order = chronological for YYYY-MM-DD prefix
  } catch {
    return [];
  }
}

/** Unique archive filename that doesn't collide with existing files. */
function uniqueArchiveName(dir: string, stem: string): string {
  const base = `${stem}.${datestamp()}.jsonl.gz`;
  const candidate = path.join(dir, base);
  if (!fs.existsSync(candidate)) {
    return candidate;
  }
  // Append an incrementing suffix if there's already an archive for today
  for (let n = 2; n < 100; n++) {
    const c = path.join(dir, `${stem}.${datestamp()}.${n}.jsonl.gz`);
    if (!fs.existsSync(c)) {
      return c;
    }
  }
  return candidate; // fallback: overwrite
}

function rotateJsonl(filePath: string, opts: RotateOptions): RotateSummary {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath); // e.g. "api.request.jsonl"
  const stem = base.replace(/\.jsonl$/, ""); // "api.request"

  let sizeBefore = 0;
  try {
    sizeBefore = fs.statSync(filePath).size;
  } catch {
    return { file: filePath, sizeBefore: 0, archivePath: "", pruned: [], skipped: true };
  }

  if (sizeBefore < opts.threshold) {
    return { file: filePath, sizeBefore, archivePath: "", pruned: [], skipped: true };
  }

  const archivePath = uniqueArchiveName(dir, stem);
  vlog(
    opts,
    `Rotating ${base} (${(sizeBefore / 1024 / 1024).toFixed(1)} MB) → ${path.basename(archivePath)}`,
  );

  if (!opts.dryRun) {
    // Read → compress → write archive → truncate original
    const content = fs.readFileSync(filePath);
    const compressed = gzipSync(content);
    fs.writeFileSync(archivePath, compressed);
    // Truncate (overwrite with empty) to preserve any in-flight appends
    fs.writeFileSync(filePath, "");
  }

  // Prune old archives beyond the keep limit
  const pruned: string[] = [];
  if (opts.keep > 0) {
    const archives = listArchives(dir, stem);
    // archives is oldest-first; remove from the front until we're within limit
    // The newly created archive counts toward the limit
    const limit = opts.keep;
    const toRemove = archives.slice(0, Math.max(0, archives.length + 1 - limit));
    for (const old of toRemove) {
      vlog(opts, `  Pruning old archive: ${path.basename(old)}`);
      if (!opts.dryRun) {
        try {
          fs.rmSync(old);
        } catch {
          /* ignore */
        }
      }
      pruned.push(old);
    }
  }

  return { file: filePath, sizeBefore, archivePath, pruned, skipped: false };
}

// ---------------------------------------------------------------------------
// Monthly DB archiving
// ---------------------------------------------------------------------------

type ArchiveDbResult = {
  month: string;
  rows: number;
  archivePath: string;
};

const ARCHIVE_SCHEMA = `
CREATE TABLE IF NOT EXISTS structured_logs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  row_hash    TEXT    NOT NULL UNIQUE,
  source_file TEXT    NOT NULL,
  time        TEXT,
  event       TEXT,
  level       TEXT,
  message     TEXT,
  extra_json  TEXT
);
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
`;

function archiveOldRows(opts: RotateOptions): ArchiveDbResult[] {
  const results: ArchiveDbResult[] = [];

  if (!fs.existsSync(opts.dbPath)) {
    vlog(opts, "No main DB found; skipping monthly archive step");
    return results;
  }

  const archiveDir = path.join(opts.dir, "archive");
  if (!opts.dryRun) {
    fs.mkdirSync(archiveDir, { recursive: true });
  }

  const currentMonth = new Date().toISOString().slice(0, 7); // "YYYY-MM"

  const db = opts.dryRun ? null : openSqlite(opts.dbPath);

  for (const table of ["structured_logs", "server_logs"] as const) {
    // Find distinct months in the data (excluding the current month)
    let months: string[] = [];
    if (db) {
      const rows = db
        .prepare(
          `SELECT DISTINCT substr(time, 1, 7) AS month
           FROM ${table}
           WHERE time IS NOT NULL
             AND substr(time, 1, 7) < ?
           ORDER BY month`,
        )
        .all(currentMonth) as { month: string }[];
      months = rows.map((r) => r.month).filter((m) => m && m.length === 7);
    } else {
      // dry-run: nothing to enumerate, just note
      vlog(opts, `[dry-run] Would query ${table} for archivable months`);
    }

    for (const month of months) {
      const archivePath = path.join(archiveDir, `${month}.db`);
      vlog(opts, `Archiving ${table} rows for ${month} → ${archivePath}`);

      if (opts.dryRun || !db) {
        results.push({ month, rows: 0, archivePath });
        continue;
      }

      const archiveDb = openSqlite(archivePath);
      archiveDb.exec(ARCHIVE_SCHEMA);

      // Copy rows — INSERT OR IGNORE for idempotency
      const rowsToMove = db
        .prepare(
          `SELECT * FROM ${table}
           WHERE time IS NOT NULL AND substr(time, 1, 7) = ?`,
        )
        .all(month) as Record<string, unknown>[];

      let inserted = 0;
      if (rowsToMove.length > 0) {
        const sample = rowsToMove[0];
        const cols = Object.keys(sample).filter((k) => k !== "id");
        const placeholders = cols.map(() => "?").join(", ");
        const insertStmt = archiveDb.prepare(
          `INSERT OR IGNORE INTO ${table} (${cols.join(", ")}) VALUES (${placeholders})`,
        );
        for (const row of rowsToMove) {
          const vals = cols.map((c) => row[c] ?? null);
          const r = insertStmt.run(...vals);
          if (r.changes > 0) {
            inserted++;
          }
        }
      }

      archiveDb.close();

      // Delete archived rows from main DB
      const deleted = db
        .prepare(
          `DELETE FROM ${table}
         WHERE time IS NOT NULL AND substr(time, 1, 7) = ?`,
        )
        .run(month);

      vlog(opts, `  ${table}: copied=${inserted} deleted=${deleted.changes}`);
      results.push({ month, rows: inserted, archivePath });
    }
  }

  if (db) {
    db.close();
  }
  return results;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const opts = parseArgs(process.argv);

  vlog(opts, `dir       = ${opts.dir}`);
  vlog(opts, `threshold = ${(opts.threshold / 1024 / 1024).toFixed(1)} MB`);
  vlog(opts, `keep      = ${opts.keep}`);
  vlog(opts, `archive-db= ${opts.archiveDb}`);
  vlog(opts, `dry-run   = ${opts.dryRun}`);

  // List all *.jsonl files in the log dir
  let jsonlFiles: string[] = [];
  try {
    jsonlFiles = fs
      .readdirSync(opts.dir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith(".jsonl"))
      .map((e) => path.join(opts.dir, e.name));
  } catch {
    vlog(opts, `Log directory not found: ${opts.dir}`);
  }

  const rotations: RotateSummary[] = [];
  for (const f of jsonlFiles) {
    const summary = rotateJsonl(f, opts);
    if (!summary.skipped) {
      rotations.push(summary);
    }
  }

  let archiveResults: ArchiveDbResult[] = [];
  if (opts.archiveDb) {
    archiveResults = archiveOldRows(opts);
  }

  // Summary output
  process.stdout.write(
    JSON.stringify({
      dryRun: opts.dryRun,
      rotations: rotations.map((r) => ({
        file: path.basename(r.file),
        sizeMB: Number((r.sizeBefore / 1024 / 1024).toFixed(2)),
        archive: path.basename(r.archivePath),
        pruned: r.pruned.map((p) => path.basename(p)),
      })),
      archives: archiveResults.map((a) => ({
        month: a.month,
        rows: a.rows,
        db: path.basename(a.archivePath),
      })),
    }) + "\n",
  );
}

main().catch((err) => {
  process.stderr.write(`log-rotate: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
