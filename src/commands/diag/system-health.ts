/**
 * System health check for the OpenClaw agent.
 *
 * Checks:
 *  1. Gateway port reachability (TCP probe)
 *  2. Gateway health RPC (channels, sessions, heartbeat)
 *  3. Recent errors in the structured event log
 *  4. Recent errors in the gateway file log
 *
 * Outputs a pass/fail summary and respects exponential-backoff alert state
 * so repeated runs don't spam the same alert.
 */
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { readConfigFileSnapshot, resolveGatewayPort } from "../../config/config.js";
import { resolveLogDir } from "../../event-log/writer.js";
import { callGateway } from "../../gateway/call.js";
import type { RuntimeEnv } from "../../runtime.js";
import { defaultRuntime } from "../../runtime.js";
import { colorize, isRich, theme } from "../../terminal/theme.js";
import { clearAlert, recordAlert, shouldAlert } from "./alert-state.js";

export type SystemHealthOptions = {
  /** Maximum age (ms) for event-log errors to be flagged. Default: 1 hour. */
  recentWindowMs?: number;
  /** Skip the alert-state check and always print. */
  force?: boolean;
  /** Emit raw JSON summary. */
  json?: boolean;
  /** Gateway URL override. */
  url?: string;
  /** Gateway token override. */
  token?: string;
};

type CheckResult = {
  name: string;
  ok: boolean;
  detail?: string;
};

// ---------------------------------------------------------------------------
// TCP probe
// ---------------------------------------------------------------------------

function probeTcpPort(host: string, port: number, timeoutMs = 3_000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, timeoutMs);
    socket.on("connect", () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(true);
    });
    socket.on("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

// ---------------------------------------------------------------------------
// Event-log error scan
// ---------------------------------------------------------------------------

type EventLogLine = {
  time?: string;
  level?: string;
  event?: string;
  message?: string;
};

async function scanEventLogErrors(
  recentWindowMs: number,
  logDir?: string,
): Promise<{ count: number; sample: string[] }> {
  const dir = resolveLogDir(logDir);
  const filePath = path.join(dir, "all.jsonl");
  const now = Date.now();
  const cutoff = now - recentWindowMs;

  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf-8");
  } catch {
    return { count: 0, sample: [] };
  }

  const errors: string[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      const obj = JSON.parse(trimmed) as EventLogLine;
      if (obj.level !== "error" && obj.level !== "fatal") {
        continue;
      }
      if (obj.time && new Date(obj.time).getTime() < cutoff) {
        continue;
      }
      errors.push(`[${obj.level}] ${obj.event ?? "?"} — ${obj.message ?? ""}`);
    } catch {
      // ignore malformed lines
    }
  }
  return { count: errors.length, sample: errors.slice(-5) };
}

// ---------------------------------------------------------------------------
// Gateway log scan (file-based)
// ---------------------------------------------------------------------------

async function scanGatewayLogErrors(
  recentWindowMs: number,
): Promise<{ count: number; sample: string[] }> {
  const logPath = process.env.OPENCLAW_GATEWAY_LOG ?? "/tmp/openclaw-gateway.log";
  const now = Date.now();
  const cutoff = now - recentWindowMs;

  let raw: string;
  try {
    raw = await fs.readFile(logPath, "utf-8");
  } catch {
    return { count: 0, sample: [] };
  }

  // Keep last 2000 lines to avoid reading massive files into memory repeatedly.
  const lines = raw.split("\n").filter(Boolean);
  const recent = lines.slice(-2000);

  const errors: string[] = [];
  for (const line of recent) {
    const lower = line.toLowerCase();
    if (!lower.includes("error") && !lower.includes("uncaught") && !lower.includes("fatal")) {
      continue;
    }
    // Best-effort timestamp extraction from common log formats.
    const tsMatch = line.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    if (tsMatch) {
      const ts = new Date(tsMatch[0]).getTime();
      if (Number.isFinite(ts) && ts < cutoff) {
        continue;
      }
    }
    errors.push(line.slice(0, 200));
  }
  return { count: errors.length, sample: errors.slice(-5) };
}

// ---------------------------------------------------------------------------
// Main health-check runner
// ---------------------------------------------------------------------------

export type SystemHealthSummary = {
  ok: boolean;
  ts: number;
  checks: CheckResult[];
};

export async function runSystemHealthCheck(
  options: SystemHealthOptions = {},
  runtime: RuntimeEnv = defaultRuntime,
): Promise<SystemHealthSummary> {
  const recentWindowMs = options.recentWindowMs ?? 60 * 60_000;
  const rich = isRich();

  const snapshot = await readConfigFileSnapshot();
  const cfg = snapshot.valid ? snapshot.config : {};
  const port = resolveGatewayPort(cfg);

  const checks: CheckResult[] = [];

  // --- 1. TCP port probe -------------------------------------------------------
  const portReachable = await probeTcpPort("127.0.0.1", port);
  checks.push({
    name: `gateway port ${port}`,
    ok: portReachable,
    detail: portReachable ? undefined : `Nothing listening on 127.0.0.1:${port}`,
  });

  // --- 2. Gateway health RPC ---------------------------------------------------
  let healthOk = false;
  let healthDetail: string | undefined;
  if (portReachable) {
    try {
      const res = await callGateway({
        url: options.url,
        token: options.token,
        method: "health",
        params: {},
        timeoutMs: 8_000,
      });
      healthOk = res?.ok === true;
      if (!healthOk) {
        healthDetail = "health RPC returned non-ok";
      }
    } catch (err) {
      healthDetail = String(err).slice(0, 120);
    }
  } else {
    healthDetail = "skipped (port unreachable)";
  }
  checks.push({ name: "gateway health RPC", ok: healthOk, detail: healthDetail });

  // --- 3. Event-log error scan -------------------------------------------------
  const evtErrors = await scanEventLogErrors(recentWindowMs);
  const evtOk = evtErrors.count === 0;
  checks.push({
    name: "event log (recent errors)",
    ok: evtOk,
    detail: evtOk
      ? undefined
      : `${evtErrors.count} error(s) in last ${Math.round(recentWindowMs / 60_000)}m`,
  });

  // --- 4. Gateway file-log scan ------------------------------------------------
  const gwErrors = await scanGatewayLogErrors(recentWindowMs);
  const gwOk = gwErrors.count === 0;
  checks.push({
    name: "gateway file log",
    ok: gwOk,
    detail: gwOk
      ? undefined
      : `${gwErrors.count} error line(s) in last ${Math.round(recentWindowMs / 60_000)}m`,
  });

  const allOk = checks.every((c) => c.ok);
  const summary: SystemHealthSummary = { ok: allOk, ts: Date.now(), checks };

  if (options.json) {
    runtime.log(JSON.stringify(summary, null, 2));
    return summary;
  }

  // ---------------------------------------------------------------------------
  // Alert-state gating: only print failure alerts when backoff allows.
  // ---------------------------------------------------------------------------
  const ALERT_KEY = "system-health";
  const allowed = options.force || (await shouldAlert(ALERT_KEY));

  if (!allOk) {
    if (allowed) {
      await recordAlert(ALERT_KEY);
    } else {
      // Silent: still return summary but don't spam the terminal.
      return summary;
    }
  } else {
    await clearAlert(ALERT_KEY);
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------
  const pass = colorize(rich, theme.success, "PASS");
  const fail = colorize(rich, theme.error, "FAIL");
  const header = colorize(rich, theme.heading, "=== System Health ===");

  runtime.log(header);
  for (const check of checks) {
    const badge = check.ok ? pass : fail;
    const label = colorize(rich, theme.info, check.name);
    const detail = check.detail ? colorize(rich, theme.muted, `  ${check.detail}`) : "";
    runtime.log(`  ${badge}  ${label}${detail}`);
  }

  // Event-log error samples
  if (!evtOk && evtErrors.sample.length > 0) {
    runtime.log(colorize(rich, theme.muted, "\nRecent event-log errors:"));
    for (const line of evtErrors.sample) {
      runtime.log(colorize(rich, theme.error, `  ${line}`));
    }
  }

  // Gateway log error samples
  if (!gwOk && gwErrors.sample.length > 0) {
    runtime.log(colorize(rich, theme.muted, "\nRecent gateway log errors:"));
    for (const line of gwErrors.sample) {
      runtime.log(colorize(rich, theme.error, `  ${line.slice(0, 160)}`));
    }
  }

  const overallLabel = allOk
    ? colorize(rich, theme.success, "Overall: OK")
    : colorize(rich, theme.error, "Overall: DEGRADED");
  runtime.log(`\n${overallLabel}`);

  return summary;
}
