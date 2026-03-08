---
title: "Writing Events — Event-Log Library"
summary: "How to import and use the event-log TypeScript library to emit structured JSONL events with automatic secret redaction."
---

# Writing Events

The event-log library lives at `src/event-log/` and is the only entry point for writing structured log entries from TypeScript code.

## Quick Start

```typescript
import { eventLog } from "./src/event-log/index.js";

// Basic event
eventLog.info("api.request", "POST /v1/messages", {
  model: "claude-opus-4-6",
  tokens: 512,
});

// Warning with extra fields
eventLog.warn("api.request", "rate limit approaching", {
  remaining: 10,
  retryAfter: 30,
});

// Error
eventLog.error("auth.login", "invalid token", {
  user: "alice",
  ip: "10.0.0.1",
});
```

Each call writes one JSON line to **two files** atomically:

- `data/logs/api.request.jsonl` — per-event file for that event name
- `data/logs/all.jsonl` — unified stream containing every event

## Log Levels

| Method           | Level   | Typical Use                 |
| ---------------- | ------- | --------------------------- |
| `eventLog.trace` | `trace` | Very detailed diagnostics   |
| `eventLog.debug` | `debug` | Development-time inspection |
| `eventLog.info`  | `info`  | Normal operational events   |
| `eventLog.warn`  | `warn`  | Recoverable issues          |
| `eventLog.error` | `error` | Unexpected failures         |
| `eventLog.fatal` | `fatal` | Process-ending failures     |

## Event Names

Event names become file-stem names on disk. Use **dot-separated identifiers** in the style `<domain>.<action>`:

```
api.request
api.response
auth.login
auth.logout
channel.message.received
agent.run.started
agent.run.finished
```

Characters outside `[A-Za-z0-9._-]` are replaced with `_`. Leading/trailing dots and hyphens are stripped.

## Output Format

Every line is a JSON object with at least:

```json
{
  "time": "2026-03-08T21:29:24.630-04:00",
  "event": "api.request",
  "level": "info",
  "message": "POST /v1/messages",
  "model": "claude-opus-4-6",
  "tokens": 512
}
```

- `time` — ISO-8601 with local timezone offset (not UTC-normalised, so local intent is preserved)
- Extra fields passed as the fourth argument are spread at the top level

## Automatic Secret Redaction

All string values are automatically scanned for secrets **before** writing to disk. This uses the same patterns as the rest of OpenClaw (`src/logging/redact.ts`), including:

- `sk-*` API keys
- `ghp_*` / `github_pat_*` GitHub tokens
- `xox*` Slack tokens
- `Bearer <token>` auth headers
- PEM private key blocks
- ENV-style `KEY=value` assignments
- JSON `"token": "..."` fields
- Telegram bot tokens

**Example — a secret token is partially masked:**

```typescript
eventLog.info("auth.login", "user authenticated", {
  user: "alice",
  token: "sk-abc123456789012345",
});
// Written to disk:
// {"time":"...","event":"auth.login","level":"info",
//  "message":"user authenticated","user":"alice","token":"sk-abc…2345"}
```

Tokens shorter than 18 characters are replaced with `***` entirely.

To **disable** redaction for a specific call (e.g. writing a known-safe diagnostic):

```typescript
import { writeEvent } from "./src/event-log/index.js";

writeEvent("debug.dump", "info", "raw config", { cfg: rawConfig }, { skipRedact: true });
```

## Configuration

### Log Directory

By default logs are written to `data/logs/` relative to the current working directory.

Override with an environment variable:

```bash
OPENCLAW_EVENT_LOG_DIR=/var/log/openclaw/events node ...
```

Or pass `logDir` per-call:

```typescript
writeEvent("my.event", "info", "hello", {}, { logDir: "/custom/path" });
```

### File Descriptors

The writer caches open file descriptors for performance. On a clean shutdown call:

```typescript
import { flushAndCloseAll } from "./src/event-log/index.js";

process.on("exit", flushAndCloseAll);
```

This is optional — the OS closes file descriptors on process exit — but it ensures all buffered writes are flushed if you're running under a runtime that defers I/O.

## Low-Level API

`writeEvent` is the underlying function used by all `eventLog.*` methods:

```typescript
import { writeEvent } from "./src/event-log/index.js";

writeEvent(
  event: string,            // event name
  level: LogLevel,          // "trace"|"debug"|"info"|"warn"|"error"|"fatal"
  message: string,          // human-readable description
  fields?: Record<string, unknown>,  // extra structured fields
  opts?: {
    logDir?: string;        // override log directory
    skipRedact?: boolean;   // disable auto-redaction
  },
): void
```

## TypeScript Types

```typescript
import type { EventLogEntry, LogLevel, WriteEventOptions } from "./src/event-log/index.js";

type EventLogEntry = {
  time: string;
  event: string;
  level: LogLevel;
  message: string;
  [key: string]: unknown;
};

type LogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal";

type WriteEventOptions = {
  logDir?: string;
  skipRedact?: boolean;
};
```
