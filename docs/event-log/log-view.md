---
title: "Log Viewer CLI — log-view.ts"
summary: "Reference for the log-view.ts CLI: filter JSONL event logs by event name, level, content, or time range; tail live files."
---

# Log Viewer CLI (`log-view.ts`)

`scripts/log-view.ts` is a terminal tool for reading, filtering, and tailing the structured JSONL event logs.

## Usage

```bash
bun scripts/log-view.ts [options]
# or via node + tsx
node --import tsx/esm scripts/log-view.ts [options]
```

## Options

| Flag             | Type                | Default     | Description                                                                                            |
| ---------------- | ------------------- | ----------- | ------------------------------------------------------------------------------------------------------ |
| `--dir <path>`   | string              | `data/logs` | Log directory (overrides `OPENCLAW_EVENT_LOG_DIR`)                                                     |
| `--event <name>` | string (repeatable) | —           | Filter to entries whose `event` field matches. Reads the per-event `.jsonl` file directly (fast path). |
| `--level <lvl>`  | string              | —           | Minimum severity: `trace` · `debug` · `info` · `warn` · `error` · `fatal`                              |
| `--match <text>` | string              | —           | Case-insensitive substring match against the raw JSON line                                             |
| `--from <iso>`   | ISO-8601            | —           | Include entries at or after this timestamp                                                             |
| `--to <iso>`     | ISO-8601            | —           | Include entries at or before this timestamp                                                            |
| `--limit <n>`    | integer             | unlimited   | Stop after emitting _n_ matching entries                                                               |
| `--json`         | flag                | off         | Emit raw JSONL instead of human-readable output                                                        |
| `--all`          | flag                | off         | Force reading `all.jsonl` even when `--event` is set                                                   |
| `--follow`       | flag                | off         | Tail the file and stream new entries as they arrive                                                    |
| `-h`, `--help`   | flag                | —           | Print help and exit                                                                                    |

## Output Modes

### Human-readable (default)

When stdout is a TTY the output is colour-coded by level:

```
2026-03-08 21:29:24 INFO  api.request POST /v1/messages {"model":"claude-opus-4-6","tokens":512}
2026-03-08 21:29:24 WARN  api.request rate limit approaching {"remaining":10}
2026-03-08 21:29:24 INFO  auth.login  user authenticated {"user":"alice","token":"sk-abc…2345"}
```

Colours:

- `FATAL` / `ERROR` — red
- `WARN` — yellow
- `INFO` — cyan
- `DEBUG` / `TRACE` — dim grey

Pass `--plain` (no flag; disable with `NO_COLOR=1` or pipe) to strip ANSI codes.

### JSON output (`--json`)

Each matching entry is emitted as its original raw JSONL line, one per line. Useful for piping to `jq` or other tooling:

```bash
bun scripts/log-view.ts --event api.request --json | jq '.tokens'
```

## Examples

### Show all warnings and above

```bash
bun scripts/log-view.ts --level warn
```

### Show all events of a specific type, as JSON

```bash
bun scripts/log-view.ts --event api.request --json
```

### Search for a substring across all events

```bash
bun scripts/log-view.ts --match "timeout"
```

### Filter by time range

```bash
bun scripts/log-view.ts --from 2026-03-08T00:00:00Z --to 2026-03-08T23:59:59Z
```

### Combine filters

```bash
bun scripts/log-view.ts --event api.request --level error --match "claude" --limit 50
```

### Tail live events (blocking)

```bash
bun scripts/log-view.ts --follow
# or for a single event type
bun scripts/log-view.ts --event api.request --follow
```

`--follow` polls the file every 500 ms and emits new lines as they appear. It first prints the existing contents of the file, then streams new entries. Handles file rotation (truncation) by resetting the cursor.

### Pipe to jq for custom analysis

```bash
bun scripts/log-view.ts --event api.request --json \
  | jq -s 'group_by(.level) | map({level: .[0].level, count: length})'
```

## File Selection

When `--event <name>` is given, the viewer reads `data/logs/<name>.jsonl` directly — this is faster than scanning `all.jsonl` for large log directories.

Pass `--all` to force reading `all.jsonl` instead (useful when you want cross-event time ordering):

```bash
bun scripts/log-view.ts --event api.request --all --from 2026-03-08T10:00:00Z
```

Multiple `--event` flags read multiple per-event files in sequence:

```bash
bun scripts/log-view.ts --event api.request --event auth.login --level error
```

## Environment Variables

| Variable                 | Description                                   |
| ------------------------ | --------------------------------------------- |
| `OPENCLAW_EVENT_LOG_DIR` | Default log directory (overridden by `--dir`) |
