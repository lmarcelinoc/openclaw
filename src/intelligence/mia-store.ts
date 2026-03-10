import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { requireNodeSqlite } from "../memory/sqlite.js";

// ============================================================================
// DB path resolution
// ============================================================================

export function resolveMiaDbDir(): string {
  const override = process.env.MIA_DB_DIR?.trim();
  if (override) {
    return path.resolve(override);
  }
  const home = process.env.OPENCLAW_HOME ?? path.join(os.homedir(), ".openclaw");
  return path.join(home, "mia");
}

// ============================================================================
// DB Handle Cache (per-directory)
// ============================================================================

const DB_CACHE = new Map<string, import("node:sqlite").DatabaseSync>();

/** Open (or reuse a cached) DatabaseSync for Mia's store.
 *  Returns null if node:sqlite is unavailable. */
export function openMiaDb(dir?: string): import("node:sqlite").DatabaseSync | null {
  const dbDir = dir ?? resolveMiaDbDir();
  const cached = DB_CACHE.get(dbDir);
  if (cached) {
    return cached;
  }

  let DatabaseSync: typeof import("node:sqlite").DatabaseSync;
  try {
    ({ DatabaseSync } = requireNodeSqlite());
  } catch {
    return null;
  }
  try {
    fs.mkdirSync(dbDir, { recursive: true });
  } catch {
    // ignore — dir may already exist
  }
  const dbPath = path.join(dbDir, "mia.sqlite");
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA foreign_keys = OFF");
  ensureMiaDbSchema(db);
  DB_CACHE.set(dbDir, db);
  return db;
}

/** Ensure the Mia DB is initialized and return its directory, or null if node:sqlite is unavailable. */
export function ensureMiaDb(_runtime?: unknown): { dir: string } | null {
  const dbDir = resolveMiaDbDir();
  const db = openMiaDb(dbDir);
  if (!db) {
    return null;
  }
  return { dir: dbDir };
}

/** Clear all cached DB handles (used in tests to reset state between runs). */
export function clearMiaDbCacheForTest(): void {
  for (const db of DB_CACHE.values()) {
    try {
      db.close();
    } catch {
      // ignore
    }
  }
  DB_CACHE.clear();
}

// ============================================================================
// Schema
// ============================================================================

/** Add a column to a table only if it does not already exist. Idempotent. */
function addColumnIfMissing(
  db: import("node:sqlite").DatabaseSync,
  table: string,
  column: string,
  definition: string,
): void {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (rows.some((row) => row.name === column)) {
    return;
  }
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

/** Initialize Mia's schema. Idempotent — safe to call on every open. */
export function ensureMiaDbSchema(db: import("node:sqlite").DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  // tasks: definitions for every recurring, overnight, and adhoc task.
  // type: scheduled | overnight | adhoc | household | reactive
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id                  TEXT    PRIMARY KEY,
      type                TEXT    NOT NULL,
      description         TEXT    NOT NULL,
      prompt              TEXT    NOT NULL,
      schedule            TEXT,
      enabled             INTEGER NOT NULL DEFAULT 1,
      priority            INTEGER NOT NULL DEFAULT 5,
      max_retries         INTEGER NOT NULL DEFAULT 3,
      retry_delay_seconds INTEGER NOT NULL DEFAULT 300,
      created_at          INTEGER NOT NULL,
      updated_at          INTEGER NOT NULL
    );
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_type    ON tasks(type);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_enabled ON tasks(enabled);`);

  // task_queue: pending/running/done execution instances.
  // status: pending | running | done | failed | cancelled
  // triggered_by: heartbeat | telegram:<id> | event:<name>
  db.exec(`
    CREATE TABLE IF NOT EXISTS task_queue (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id       TEXT    NOT NULL,
      status        TEXT    NOT NULL DEFAULT 'pending',
      scheduled_for INTEGER NOT NULL,
      started_at    INTEGER,
      completed_at  INTEGER,
      retry_count   INTEGER NOT NULL DEFAULT 0,
      output        TEXT,
      error         TEXT,
      triggered_by  TEXT,
      created_at    INTEGER NOT NULL
    );
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_task_queue_task_id       ON task_queue(task_id);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_task_queue_status        ON task_queue(status);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_task_queue_scheduled_for ON task_queue(scheduled_for);`);

  // errors: structured error log with resolution tracking.
  // error_type: rate_limit | auth | network | data | unknown | stale
  db.exec(`
    CREATE TABLE IF NOT EXISTS errors (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      task_queue_id INTEGER,
      task_id       TEXT,
      error_type    TEXT    NOT NULL,
      message       TEXT    NOT NULL,
      stack         TEXT,
      resolved      INTEGER NOT NULL DEFAULT 0,
      resolution    TEXT,
      notified      INTEGER NOT NULL DEFAULT 0,
      occurred_at   INTEGER NOT NULL,
      resolved_at   INTEGER
    );
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_errors_task_id    ON errors(task_id);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_errors_resolved   ON errors(resolved);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_errors_notified   ON errors(notified);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_errors_occurred_at ON errors(occurred_at);`);

  // social_metrics: per-platform metric snapshots, one row per item per day.
  // platform: twitter | instagram | linkedin | youtube
  // metric_type: post | account | story | video
  db.exec(`
    CREATE TABLE IF NOT EXISTS social_metrics (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      platform      TEXT    NOT NULL,
      metric_type   TEXT    NOT NULL,
      source_id     TEXT    NOT NULL,
      metrics_json  TEXT    NOT NULL,
      collected_at  INTEGER NOT NULL
    );
  `);
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_social_metrics_platform     ON social_metrics(platform);`,
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_social_metrics_collected_at ON social_metrics(collected_at);`,
  );
  // One snapshot per platform+source per calendar day (unix_day = collected_at / 86400000).
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_social_metrics_dedup
      ON social_metrics(platform, source_id, (collected_at / 86400000));
  `);

  // household_tasks: to-dos Mia can manage autonomously.
  // category: home | admin | shopping | kids | self
  // status: open | done | snoozed
  // recurrence: daily | weekly | monthly | null
  db.exec(`
    CREATE TABLE IF NOT EXISTS household_tasks (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      title         TEXT    NOT NULL,
      category      TEXT    NOT NULL,
      due_date      INTEGER,
      recurrence    TEXT,
      status        TEXT    NOT NULL DEFAULT 'open',
      snoozed_until INTEGER,
      auto_resolve  INTEGER NOT NULL DEFAULT 1,
      notes         TEXT,
      created_at    INTEGER NOT NULL,
      updated_at    INTEGER NOT NULL,
      completed_at  INTEGER
    );
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_household_tasks_status   ON household_tasks(status);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_household_tasks_due_date ON household_tasks(due_date);`);

  // shopping: grocery / household shopping list.
  // category: grocery | pharmacy | household | other
  db.exec(`
    CREATE TABLE IF NOT EXISTS shopping (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      item      TEXT    NOT NULL,
      quantity  TEXT,
      category  TEXT,
      bought    INTEGER NOT NULL DEFAULT 0,
      added_at  INTEGER NOT NULL,
      bought_at INTEGER
    );
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_shopping_bought ON shopping(bought);`);

  // content_ideas: social content pipeline with cosine-similarity dedup.
  // platform: twitter | instagram | linkedin | youtube
  // status: proposed | accepted | rejected | drafted | posted
  db.exec(`
    CREATE TABLE IF NOT EXISTS content_ideas (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      title          TEXT    NOT NULL,
      angle          TEXT,
      outline        TEXT,
      sources_json   TEXT,
      platform       TEXT,
      status         TEXT    NOT NULL DEFAULT 'proposed',
      embedding_json TEXT,
      created_at     INTEGER NOT NULL,
      updated_at     INTEGER NOT NULL
    );
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_content_ideas_status ON content_ideas(status);`);

  // heartbeat_state: key-value store for last-checked timestamps.
  db.exec(`
    CREATE TABLE IF NOT EXISTS heartbeat_state (
      key        TEXT PRIMARY KEY,
      value      TEXT,
      updated_at INTEGER NOT NULL
    );
  `);

  // projects: user-defined work projects. Tasks and household_tasks reference these via project_id.
  // status: active | blocked | paused | completed
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id          TEXT    PRIMARY KEY,
      name        TEXT    NOT NULL,
      description TEXT,
      url         TEXT,
      status      TEXT    NOT NULL DEFAULT 'active',
      stack       TEXT,
      notes       TEXT,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    );
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_projects_status ON projects(status);`);

  // Idempotent migrations: add project_id to tasks and household_tasks.
  addColumnIfMissing(db, "tasks", "project_id", "TEXT REFERENCES projects(id)");
  addColumnIfMissing(db, "household_tasks", "project_id", "TEXT REFERENCES projects(id)");

  db.exec(`INSERT OR IGNORE INTO schema_meta (key, value) VALUES ('schema_version', '1');`);
}

// ============================================================================
// Default task definitions
// ============================================================================

export type TaskRow = {
  id: string;
  type: string;
  description: string;
  prompt: string;
  schedule: string | null;
  enabled: number;
  priority: number;
  max_retries: number;
  retry_delay_seconds: number;
  project_id: string | null;
  created_at: number;
  updated_at: number;
};

const DEFAULT_TASKS: Omit<TaskRow, "created_at" | "updated_at" | "project_id">[] = [
  {
    id: "morning-briefing",
    type: "scheduled",
    description: "Morning briefing: social delta + community pulse + household today",
    prompt:
      "Generate the user's morning briefing. Query mia.sqlite for: (1) social_metrics collected in the last 24h — summarise impressions/follower delta per platform, (2) household_tasks WHERE status='open' AND due_date <= today — list in priority order, (3) shopping items WHERE bought=0 — include count. Keep it concise. Deliver to the user's Telegram DM.",
    schedule: "0 8 * * *",
    enabled: 1,
    priority: 1,
    max_retries: 3,
    retry_delay_seconds: 300,
  },
  {
    id: "social-monitor",
    type: "scheduled",
    description: "Check mentions/replies needing attention; flag high-engagement posts",
    prompt:
      "Check all 4 social platforms (Twitter/X, Instagram, LinkedIn, YouTube) for new mentions, comments, and replies since last check (heartbeat_state key='social-monitor-last-run'). Flag anything requiring the user's attention. Update heartbeat_state. Only notify if there is something actionable — stay silent otherwise.",
    schedule: "0 9,12,15,18,21 * * *",
    enabled: 1,
    priority: 2,
    max_retries: 3,
    retry_delay_seconds: 120,
  },
  {
    id: "social-sync",
    type: "overnight",
    description: "Pull fresh metrics from all 4 platforms into social_metrics",
    prompt:
      "Collect today's social metrics from Twitter/X, Instagram, LinkedIn, and YouTube. For each platform upsert rows into social_metrics (platform, metric_type, source_id, metrics_json, collected_at=now). Use idempotent upserts — safe to re-run. Log summary of rows upserted to task_queue output. Do not notify the user unless an error occurs.",
    schedule: "30 23 * * *",
    enabled: 1,
    priority: 5,
    max_retries: 3,
    retry_delay_seconds: 600,
  },
  {
    id: "weekly-social-audit",
    type: "scheduled",
    description: "7-day performance review + content gap analysis + ranked recommendations",
    prompt:
      "Run the weekly social audit. Pull 7 days of social_metrics. Produce: (1) top/worst performing posts per platform, (2) follower trend, (3) best posting times, (4) content gap analysis — topics getting traction that haven't been covered. Output ranked content recommendations. Insert each as a content_ideas row with status='proposed'. Deliver full report to the user's Telegram DM.",
    schedule: "0 9 * * 1",
    enabled: 1,
    priority: 3,
    max_retries: 2,
    retry_delay_seconds: 600,
  },
  {
    id: "household-review",
    type: "scheduled",
    description: "Weekly household review — open tasks, reset recurring, suggest weekly focus",
    prompt:
      "Review household tasks. Query household_tasks WHERE status='open'. Reset any recurring tasks that completed last week (recurrence != null AND completed_at >= 7 days ago → status='open', completed_at=null). Suggest this week's household focus (top 3 priorities). Deliver summary to the user's Telegram DM.",
    schedule: "0 18 * * 0",
    enabled: 1,
    priority: 3,
    max_retries: 2,
    retry_delay_seconds: 300,
  },
  {
    id: "household-prioritise",
    type: "scheduled",
    description: "Auto-prioritise today's tasks; reschedule overdue items",
    prompt:
      "Check household_tasks for items due today or overdue. Auto-reschedule any overdue tasks that have no fixed deadline to today+1. For tasks with auto_resolve=1 that are purely logistical (e.g. 'take out bins', 'start dishwasher'), mark done and log the action. Update updated_at. Do not notify the user unless there are 3+ urgent items due today.",
    schedule: "45 7 * * *",
    enabled: 1,
    priority: 2,
    max_retries: 2,
    retry_delay_seconds: 120,
  },
  {
    id: "memory-synthesis",
    type: "overnight",
    description: "Synthesise daily memory notes into MEMORY.md",
    prompt:
      "Run the memory synthesis pipeline for the workspace. Read daily notes from workspace/memory/ for the past 7 days. Extract durable patterns, preferences, and lessons. Update workspace/MEMORY.md with new insights — do not delete existing entries, only add or refine. Log count of new insights added.",
    schedule: "0 1 * * 0",
    enabled: 1,
    priority: 8,
    max_retries: 2,
    retry_delay_seconds: 600,
  },
  {
    id: "error-report",
    type: "scheduled",
    description: "Notify user of any unresolved unnotified errors",
    prompt:
      "Query errors WHERE resolved=0 AND notified=0. If any exist, send a brief summary to the user's Telegram DM listing error_type, task_id, message, and occurred_at for each. Mark all as notified=1 after sending. Stay silent if no unnotified errors.",
    schedule: "0 * * * *",
    enabled: 1,
    priority: 1,
    max_retries: 3,
    retry_delay_seconds: 60,
  },
  {
    id: "content-idea-pipeline",
    type: "adhoc",
    description: "Dedup check → research → draft content card → store in content_ideas",
    prompt:
      "Process a content idea request. First compute a text embedding for the proposed idea title/description. Check content_ideas for any existing idea with cosine similarity > 0.4 — if found, report the duplicate and stop. Otherwise: research the topic using community activity and social trends, draft a content card (title, angle, outline, best platform), insert into content_ideas with status='proposed', and report back to the user.",
    schedule: null,
    enabled: 1,
    priority: 3,
    max_retries: 2,
    retry_delay_seconds: 60,
  },
  {
    id: "household-task-add",
    type: "adhoc",
    description: "Parse 'add task: ...' → insert household_tasks row",
    prompt:
      "Parse the incoming household task request. Extract: title, category (home/admin/shopping/kids/self — infer from context), due_date (parse natural language date if given), recurrence (if mentioned), notes. Insert into household_tasks with status='open', auto_resolve=1. Confirm to the user with the parsed details.",
    schedule: null,
    enabled: 1,
    priority: 2,
    max_retries: 1,
    retry_delay_seconds: 30,
  },
  {
    id: "shopping-add",
    type: "adhoc",
    description: "Parse 'buy: ...' / 'shopping: ...' → insert shopping row",
    prompt:
      "Parse the shopping request. Extract item name, quantity (if given), category (grocery/pharmacy/household/other — infer from item). Insert into shopping with bought=0. Confirm to the user.",
    schedule: null,
    enabled: 1,
    priority: 2,
    max_retries: 1,
    retry_delay_seconds: 30,
  },
  {
    id: "reminder",
    type: "adhoc",
    description: "Parse 'remind me [when] to ...' → queue with computed scheduled_for",
    prompt:
      "Parse the reminder request. Extract the reminder text and target time (parse natural language: 'Friday', 'in 2 hours', 'tomorrow morning 9am' → convert to Unix timestamp in the user's local timezone). Insert a new task_queue row for task_id='reminder-fire' with the computed scheduled_for. Confirm to the user with the parsed time.",
    schedule: null,
    enabled: 1,
    priority: 2,
    max_retries: 1,
    retry_delay_seconds: 30,
  },
];

/** Insert default task definitions if they do not already exist. Idempotent. */
export function seedDefaultTasks(db: import("node:sqlite").DatabaseSync): number {
  const now = Date.now();
  let inserted = 0;
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO tasks
      (id, type, description, prompt, schedule, enabled, priority, max_retries, retry_delay_seconds, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const t of DEFAULT_TASKS) {
    const result = stmt.run(
      t.id,
      t.type,
      t.description,
      t.prompt,
      t.schedule ?? null,
      t.enabled,
      t.priority,
      t.max_retries,
      t.retry_delay_seconds,
      now,
      now,
    );
    if (Number(result.changes) > 0) {
      inserted++;
    }
  }
  return inserted;
}

/** List all task definitions, optionally filtered by type/enabled/project_id. */
export function queryTasks(
  db: import("node:sqlite").DatabaseSync,
  opts: { type?: string; enabled?: boolean; projectId?: string } = {},
): TaskRow[] {
  const conditions: string[] = [];
  const params: (string | number)[] = [];
  if (opts.type) {
    conditions.push("type = ?");
    params.push(opts.type);
  }
  if (opts.enabled !== undefined) {
    conditions.push("enabled = ?");
    params.push(opts.enabled ? 1 : 0);
  }
  if (opts.projectId !== undefined) {
    conditions.push("project_id = ?");
    params.push(opts.projectId);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  return db
    .prepare(`SELECT * FROM tasks ${where} ORDER BY priority ASC`)
    .all(...params) as TaskRow[];
}

// ============================================================================
// task_queue CRUD
// ============================================================================

export type TaskQueueRow = {
  id: number;
  task_id: string;
  status: string;
  scheduled_for: number;
  started_at: number | null;
  completed_at: number | null;
  retry_count: number;
  output: string | null;
  error: string | null;
  triggered_by: string | null;
  created_at: number;
};

/** Enqueue a task instance for execution at the given time. */
export function queueTask(
  db: import("node:sqlite").DatabaseSync,
  opts: {
    taskId: string;
    scheduledFor: number;
    triggeredBy?: string;
  },
): number {
  const now = Date.now();
  const result = db
    .prepare(`
      INSERT INTO task_queue (task_id, status, scheduled_for, triggered_by, created_at)
      VALUES (?, 'pending', ?, ?, ?)
    `)
    .run(opts.taskId, opts.scheduledFor, opts.triggeredBy ?? null, now);
  return Number(result.lastInsertRowid);
}

/** Return pending tasks that are due (scheduled_for <= now), ordered by priority. */
export function getDueTasks(
  db: import("node:sqlite").DatabaseSync,
  now: number = Date.now(),
): (TaskQueueRow & { task_priority: number })[] {
  return db
    .prepare(`
      SELECT q.*, t.priority AS task_priority
      FROM task_queue q
      JOIN tasks t ON t.id = q.task_id
      WHERE q.status = 'pending'
        AND q.scheduled_for <= ?
      ORDER BY t.priority ASC, q.scheduled_for ASC
    `)
    .all(now) as (TaskQueueRow & { task_priority: number })[];
}

/** Mark a queued task as running. */
export function markTaskRunning(db: import("node:sqlite").DatabaseSync, queueId: number): void {
  db.prepare(`UPDATE task_queue SET status='running', started_at=? WHERE id=?`).run(
    Date.now(),
    queueId,
  );
}

/** Mark a queued task as done, storing its output. */
export function markTaskDone(
  db: import("node:sqlite").DatabaseSync,
  queueId: number,
  output: string,
): void {
  db.prepare(`UPDATE task_queue SET status='done', completed_at=?, output=? WHERE id=?`).run(
    Date.now(),
    output,
    queueId,
  );
}

/** Mark a queued task as failed, storing the error text. */
export function markTaskFailed(
  db: import("node:sqlite").DatabaseSync,
  queueId: number,
  error: string,
): void {
  db.prepare(`UPDATE task_queue SET status='failed', completed_at=?, error=? WHERE id=?`).run(
    Date.now(),
    error,
    queueId,
  );
}

/** Reschedule a failed task for retry (increments retry_count, resets to pending). */
export function rescheduleTaskRetry(
  db: import("node:sqlite").DatabaseSync,
  queueId: number,
  nextRunAt: number,
): void {
  db.prepare(`
    UPDATE task_queue
    SET status='pending', scheduled_for=?, retry_count=retry_count+1, started_at=NULL, completed_at=NULL
    WHERE id=?
  `).run(nextRunAt, queueId);
}

/**
 * Auto-fail task_queue rows that have been in 'running' state for more than
 * staleAfterMs milliseconds (default 30 minutes). Returns count of rows updated.
 */
export function failStaleTasks(
  db: import("node:sqlite").DatabaseSync,
  staleAfterMs: number = 30 * 60 * 1000,
): number {
  const cutoff = Date.now() - staleAfterMs;
  const result = db
    .prepare(`
      UPDATE task_queue
      SET status='failed', completed_at=?, error='Task exceeded max running time and was auto-failed'
      WHERE status='running' AND started_at < ?
    `)
    .run(Date.now(), cutoff);
  return Number(result.changes);
}

/** Query task_queue rows, newest first. */
export function queryTaskQueue(
  db: import("node:sqlite").DatabaseSync,
  opts: { taskId?: string; status?: string; limit?: number } = {},
): TaskQueueRow[] {
  const { taskId, status, limit = 50 } = opts;
  const conditions: string[] = [];
  const params: (string | number)[] = [];
  if (taskId) {
    conditions.push("task_id = ?");
    params.push(taskId);
  }
  if (status) {
    conditions.push("status = ?");
    params.push(status);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  return db
    .prepare(`SELECT * FROM task_queue ${where} ORDER BY created_at DESC LIMIT ?`)
    .all(...params, limit) as TaskQueueRow[];
}

// ============================================================================
// errors CRUD
// ============================================================================

export type ErrorRow = {
  id: number;
  task_queue_id: number | null;
  task_id: string | null;
  error_type: string;
  message: string;
  stack: string | null;
  resolved: number;
  resolution: string | null;
  notified: number;
  occurred_at: number;
  resolved_at: number | null;
};

/** Log a structured error. Returns the new error row id. */
export function logError(
  db: import("node:sqlite").DatabaseSync,
  opts: {
    errorType: string;
    message: string;
    taskId?: string;
    taskQueueId?: number;
    stack?: string;
  },
): number {
  const result = db
    .prepare(`
      INSERT INTO errors (task_queue_id, task_id, error_type, message, stack, occurred_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `)
    .run(
      opts.taskQueueId ?? null,
      opts.taskId ?? null,
      opts.errorType,
      opts.message,
      opts.stack ?? null,
      Date.now(),
    );
  return Number(result.lastInsertRowid);
}

/** Mark an error as resolved. */
export function resolveError(
  db: import("node:sqlite").DatabaseSync,
  errorId: number,
  resolution: string,
): void {
  db.prepare(`
    UPDATE errors SET resolved=1, resolution=?, resolved_at=? WHERE id=?
  `).run(resolution, Date.now(), errorId);
}

/** Return errors that occurred but have not yet been flagged to the user. */
export function getUnnotifiedErrors(
  db: import("node:sqlite").DatabaseSync,
  opts: { olderThanMs?: number } = {},
): ErrorRow[] {
  const { olderThanMs = 5 * 60 * 1000 } = opts;
  const cutoff = Date.now() - olderThanMs;
  return db
    .prepare(`
      SELECT * FROM errors
      WHERE resolved=0 AND notified=0 AND occurred_at <= ?
      ORDER BY occurred_at ASC
    `)
    .all(cutoff) as ErrorRow[];
}

/** Mark errors as notified (after Telegram message has been sent). */
export function markErrorsNotified(
  db: import("node:sqlite").DatabaseSync,
  errorIds: number[],
): void {
  if (errorIds.length === 0) {
    return;
  }
  const placeholders = errorIds.map(() => "?").join(",");
  db.prepare(`UPDATE errors SET notified=1 WHERE id IN (${placeholders})`).run(...errorIds);
}

/** Query errors, unresolved first. */
export function queryErrors(
  db: import("node:sqlite").DatabaseSync,
  opts: { taskId?: string; resolved?: boolean; limit?: number } = {},
): ErrorRow[] {
  const { taskId, resolved, limit = 50 } = opts;
  const conditions: string[] = [];
  const params: (string | number)[] = [];
  if (taskId) {
    conditions.push("task_id = ?");
    params.push(taskId);
  }
  if (resolved !== undefined) {
    conditions.push("resolved = ?");
    params.push(resolved ? 1 : 0);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  return db
    .prepare(`SELECT * FROM errors ${where} ORDER BY occurred_at DESC LIMIT ?`)
    .all(...params, limit) as ErrorRow[];
}

// ============================================================================
// social_metrics CRUD
// ============================================================================

export type SocialMetricRow = {
  id: number;
  platform: string;
  metric_type: string;
  source_id: string;
  metrics_json: string;
  collected_at: number;
};

/** Upsert a social metric snapshot (idempotent per platform+source per day). */
export function upsertSocialMetric(
  db: import("node:sqlite").DatabaseSync,
  opts: {
    platform: string;
    metricType: string;
    sourceId: string;
    metricsJson: string;
    collectedAt?: number;
  },
): void {
  const collectedAt = opts.collectedAt ?? Date.now();
  db.prepare(`
    INSERT INTO social_metrics (platform, metric_type, source_id, metrics_json, collected_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(platform, source_id, (collected_at / 86400000)) DO UPDATE SET
      metric_type  = excluded.metric_type,
      metrics_json = excluded.metrics_json,
      collected_at = excluded.collected_at
  `).run(opts.platform, opts.metricType, opts.sourceId, opts.metricsJson, collectedAt);
}

/** Query social metrics, newest first. */
export function querySocialMetrics(
  db: import("node:sqlite").DatabaseSync,
  opts: { platform?: string; since?: number; limit?: number } = {},
): SocialMetricRow[] {
  const { platform, since, limit = 200 } = opts;
  const conditions: string[] = [];
  const params: (string | number)[] = [];
  if (platform) {
    conditions.push("platform = ?");
    params.push(platform);
  }
  if (since !== undefined) {
    conditions.push("collected_at >= ?");
    params.push(since);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  return db
    .prepare(`SELECT * FROM social_metrics ${where} ORDER BY collected_at DESC LIMIT ?`)
    .all(...params, limit) as SocialMetricRow[];
}

// ============================================================================
// household_tasks CRUD
// ============================================================================

export type HouseholdTaskRow = {
  id: number;
  title: string;
  category: string;
  due_date: number | null;
  recurrence: string | null;
  status: string;
  snoozed_until: number | null;
  auto_resolve: number;
  notes: string | null;
  project_id: string | null;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
};

/** Insert a new household task. Returns the new row id. */
export function insertHouseholdTask(
  db: import("node:sqlite").DatabaseSync,
  opts: {
    title: string;
    category: string;
    dueDate?: number;
    recurrence?: string;
    autoResolve?: boolean;
    notes?: string;
  },
): number {
  const now = Date.now();
  const result = db
    .prepare(`
      INSERT INTO household_tasks
        (title, category, due_date, recurrence, status, auto_resolve, notes, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?)
    `)
    .run(
      opts.title,
      opts.category,
      opts.dueDate ?? null,
      opts.recurrence ?? null,
      opts.autoResolve !== false ? 1 : 0,
      opts.notes ?? null,
      now,
      now,
    );
  return Number(result.lastInsertRowid);
}

/** Mark a household task as done. */
export function completeHouseholdTask(
  db: import("node:sqlite").DatabaseSync,
  taskId: number,
): void {
  const now = Date.now();
  db.prepare(
    `UPDATE household_tasks SET status='done', completed_at=?, updated_at=? WHERE id=?`,
  ).run(now, now, taskId);
}

/** Query household tasks, optionally filtered by status/category/due range/project. */
export function queryHouseholdTasks(
  db: import("node:sqlite").DatabaseSync,
  opts: {
    status?: string;
    category?: string;
    dueBefore?: number;
    projectId?: string;
    limit?: number;
  } = {},
): HouseholdTaskRow[] {
  const { status, category, dueBefore, projectId, limit = 100 } = opts;
  const conditions: string[] = [];
  const params: (string | number)[] = [];
  if (status) {
    conditions.push("status = ?");
    params.push(status);
  }
  if (category) {
    conditions.push("category = ?");
    params.push(category);
  }
  if (dueBefore !== undefined) {
    conditions.push("due_date <= ?");
    params.push(dueBefore);
  }
  if (projectId !== undefined) {
    conditions.push("project_id = ?");
    params.push(projectId);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  return db
    .prepare(`SELECT * FROM household_tasks ${where} ORDER BY due_date ASC NULLS LAST LIMIT ?`)
    .all(...params, limit) as HouseholdTaskRow[];
}

// ============================================================================
// shopping CRUD
// ============================================================================

export type ShoppingRow = {
  id: number;
  item: string;
  quantity: string | null;
  category: string | null;
  bought: number;
  added_at: number;
  bought_at: number | null;
};

/** Add an item to the shopping list. Returns the new row id. */
export function addShoppingItem(
  db: import("node:sqlite").DatabaseSync,
  opts: { item: string; quantity?: string; category?: string },
): number {
  const result = db
    .prepare(`INSERT INTO shopping (item, quantity, category, added_at) VALUES (?, ?, ?, ?)`)
    .run(opts.item, opts.quantity ?? null, opts.category ?? null, Date.now());
  return Number(result.lastInsertRowid);
}

/** Mark a shopping item as bought. */
export function markShoppingBought(db: import("node:sqlite").DatabaseSync, itemId: number): void {
  db.prepare(`UPDATE shopping SET bought=1, bought_at=? WHERE id=?`).run(Date.now(), itemId);
}

/** Return the current shopping list (unbought items). */
export function getShoppingList(db: import("node:sqlite").DatabaseSync): ShoppingRow[] {
  return db
    .prepare(`SELECT * FROM shopping WHERE bought=0 ORDER BY added_at ASC`)
    .all() as ShoppingRow[];
}

// ============================================================================
// content_ideas CRUD
// ============================================================================

export type ContentIdeaRow = {
  id: number;
  title: string;
  angle: string | null;
  outline: string | null;
  sources_json: string | null;
  platform: string | null;
  status: string;
  embedding_json: string | null;
  created_at: number;
  updated_at: number;
};

/** Insert a new content idea. Returns the new row id. */
export function insertContentIdea(
  db: import("node:sqlite").DatabaseSync,
  opts: {
    title: string;
    angle?: string;
    outline?: string;
    sourcesJson?: string;
    platform?: string;
    embeddingJson?: string;
  },
): number {
  const now = Date.now();
  const result = db
    .prepare(`
      INSERT INTO content_ideas
        (title, angle, outline, sources_json, platform, status, embedding_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'proposed', ?, ?, ?)
    `)
    .run(
      opts.title,
      opts.angle ?? null,
      opts.outline ?? null,
      opts.sourcesJson ?? null,
      opts.platform ?? null,
      opts.embeddingJson ?? null,
      now,
      now,
    );
  return Number(result.lastInsertRowid);
}

/** Update a content idea's status. */
export function updateIdeaStatus(
  db: import("node:sqlite").DatabaseSync,
  ideaId: number,
  status: string,
): void {
  db.prepare(`UPDATE content_ideas SET status=?, updated_at=? WHERE id=?`).run(
    status,
    Date.now(),
    ideaId,
  );
}

/** Return all proposed content ideas with stored embeddings (for dedup check). */
export function getIdeasWithEmbeddings(db: import("node:sqlite").DatabaseSync): ContentIdeaRow[] {
  return db
    .prepare(
      `SELECT * FROM content_ideas WHERE embedding_json IS NOT NULL AND status != 'rejected' ORDER BY created_at DESC`,
    )
    .all() as ContentIdeaRow[];
}

// ============================================================================
// heartbeat_state CRUD
// ============================================================================

/** Read a heartbeat state value by key. Returns null if not set. */
export function getHeartbeatState(
  db: import("node:sqlite").DatabaseSync,
  key: string,
): string | null {
  const row = db.prepare(`SELECT value FROM heartbeat_state WHERE key=?`).get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

/** Upsert a heartbeat state value. */
export function setHeartbeatState(
  db: import("node:sqlite").DatabaseSync,
  key: string,
  value: string,
): void {
  db.prepare(`
    INSERT INTO heartbeat_state (key, value, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at
  `).run(key, value, Date.now());
}

// ============================================================================
// projects CRUD
// ============================================================================

export type ProjectRow = {
  id: string;
  name: string;
  description: string | null;
  url: string | null;
  status: string;
  stack: string | null;
  notes: string | null;
  created_at: number;
  updated_at: number;
};

/** Insert a new project. Throws if the id already exists. */
export function insertProject(
  db: import("node:sqlite").DatabaseSync,
  opts: {
    id: string;
    name: string;
    description?: string;
    url?: string;
    status?: string;
    stack?: string;
    notes?: string;
  },
): ProjectRow {
  const now = Date.now();
  db.prepare(`
    INSERT INTO projects (id, name, description, url, status, stack, notes, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    opts.id,
    opts.name,
    opts.description ?? null,
    opts.url ?? null,
    opts.status ?? "active",
    opts.stack ?? null,
    opts.notes ?? null,
    now,
    now,
  );
  return db.prepare(`SELECT * FROM projects WHERE id=?`).get(opts.id) as ProjectRow;
}

/** Update one or more fields on an existing project. */
export function updateProject(
  db: import("node:sqlite").DatabaseSync,
  id: string,
  fields: Partial<Omit<ProjectRow, "id" | "created_at" | "updated_at">>,
): ProjectRow | undefined {
  const sets: string[] = [];
  const params: (string | number | null)[] = [];
  if (fields.name !== undefined) {
    sets.push("name=?");
    params.push(fields.name);
  }
  if (fields.description !== undefined) {
    sets.push("description=?");
    params.push(fields.description ?? null);
  }
  if (fields.url !== undefined) {
    sets.push("url=?");
    params.push(fields.url ?? null);
  }
  if (fields.status !== undefined) {
    sets.push("status=?");
    params.push(fields.status);
  }
  if (fields.stack !== undefined) {
    sets.push("stack=?");
    params.push(fields.stack ?? null);
  }
  if (fields.notes !== undefined) {
    sets.push("notes=?");
    params.push(fields.notes ?? null);
  }
  if (sets.length === 0) {
    return getProject(db, id);
  }
  sets.push("updated_at=?");
  params.push(Date.now());
  params.push(id);
  db.prepare(`UPDATE projects SET ${sets.join(",")} WHERE id=?`).run(...params);
  return getProject(db, id);
}

/** Fetch a single project by id. */
export function getProject(
  db: import("node:sqlite").DatabaseSync,
  id: string,
): ProjectRow | undefined {
  return db.prepare(`SELECT * FROM projects WHERE id=?`).get(id) as ProjectRow | undefined;
}

/** Query projects, optionally filtered by status or keyword (name/description/notes search). */
export function queryProjects(
  db: import("node:sqlite").DatabaseSync,
  opts: { status?: string; keyword?: string; limit?: number } = {},
): ProjectRow[] {
  const { status, keyword, limit = 100 } = opts;
  const conditions: string[] = [];
  const params: (string | number)[] = [];
  if (status) {
    conditions.push("status = ?");
    params.push(status);
  }
  if (keyword) {
    conditions.push("(name LIKE ? OR description LIKE ? OR notes LIKE ?)");
    const like = `%${keyword}%`;
    params.push(like, like, like);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  return db
    .prepare(`SELECT * FROM projects ${where} ORDER BY status ASC, name ASC LIMIT ?`)
    .all(...params, limit) as ProjectRow[];
}

/** Delete a project by id. */
export function deleteProject(db: import("node:sqlite").DatabaseSync, id: string): void {
  db.prepare(`DELETE FROM projects WHERE id=?`).run(id);
}
