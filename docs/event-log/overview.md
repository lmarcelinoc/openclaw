---
title: "Event-Log Infrastructure — Overview"
summary: "Architecture overview of the structured event-logging system: JSONL writers, CLI viewer, SQLite ingest, and daily rotation."
---

# Event-Log Infrastructure

This section documents the structured event-logging infrastructure added to OpenClaw. It is separate from the existing gateway file logger (`src/logging/`) and is designed for **application-level events** that need long-term storage, querying, and archival.

## At a Glance

| Component          | Location                | Purpose                                           |
| ------------------ | ----------------------- | ------------------------------------------------- |
| TypeScript library | `src/event-log/`        | Write events from any TypeScript code             |
| Log viewer CLI     | `scripts/log-view.ts`   | Filter and tail JSONL files at the terminal       |
| DB ingest script   | `scripts/log-ingest.ts` | Nightly parse into SQLite for structured querying |
| Rotation script    | `scripts/log-rotate.ts` | Daily size-based rotation + monthly DB archiving  |

## How Data Flows

```
Your code
  └─ eventLog.info("api.request", "POST /messages", { model: "..." })
        │
        ├─▶  data/logs/api.request.jsonl   (per-event file)
        └─▶  data/logs/all.jsonl           (unified stream, every event)

Nightly cron (log-ingest.ts)
        ├─▶  data/logs/structured.db  (structured_logs table)
        └─▶  data/logs/structured.db  (server_logs table, from gateway .log files)

Daily cron (log-rotate.ts)
        ├─▶  data/logs/api.request.2026-03-08.jsonl.gz  (compressed archive)
        └─▶  data/logs/archive/2026-02.db               (monthly SQLite archive)
```

## Pages in This Section

- [Writing Events](writing-events.md) — Library API, redaction, and configuration
- [Viewing Logs](log-view.md) — CLI viewer reference
- [Database Ingest](log-ingest.md) — SQLite ingest script reference
- [Log Rotation](log-rotate.md) — Rotation and monthly archiving reference
- [Cron Setup](cron-setup.md) — Scheduling nightly ingest and daily rotation
