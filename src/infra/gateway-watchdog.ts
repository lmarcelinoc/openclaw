import fs from "node:fs";
import path from "node:path";
import { callGateway } from "../gateway/call.js";
import { getChildLogger } from "../logging.js";

const log = getChildLogger({ module: "gateway-watchdog" });

/** Persistent state file that tracks downtime across watchdog invocations. */
function resolveStatePath(): string {
  const home = process.env.OPENCLAW_HOME ?? path.join(process.env.HOME ?? "", ".openclaw");
  return path.join(home, "logs", "gateway-watchdog-state.json");
}

type WatchdogState = {
  /** ISO timestamp when the gateway was first detected as down. */
  downSince?: string;
  /** Whether an alert has already been sent for the current downtime window. */
  alertSent?: boolean;
  /** ISO timestamp of last successful health check. */
  lastHealthy?: string;
};

function readState(): WatchdogState {
  try {
    const raw = fs.readFileSync(resolveStatePath(), "utf-8");
    return JSON.parse(raw) as WatchdogState;
  } catch {
    return {};
  }
}

function writeState(state: WatchdogState): void {
  const statePath = resolveStatePath();
  try {
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2), "utf-8");
  } catch {
    // best-effort
  }
}

/**
 * Probe the gateway's health endpoint. Returns true if reachable.
 */
async function probeGateway(timeoutMs = 5_000): Promise<boolean> {
  try {
    await callGateway({ method: "health", timeoutMs });
    return true;
  } catch {
    return false;
  }
}

/**
 * Attempt to repair the gateway by re-bootstrapping the launchd agent (macOS)
 * or restarting the systemd unit (Linux). Returns a human-readable result.
 */
async function attemptRepair(): Promise<{ ok: boolean; detail: string }> {
  if (process.platform === "darwin") {
    try {
      const { repairLaunchAgentBootstrap, isLaunchAgentLoaded } =
        await import("../daemon/launchd.js");
      const env = process.env as Record<string, string | undefined>;
      const loaded = await isLaunchAgentLoaded({ env });
      if (!loaded) {
        log.info("LaunchAgent not loaded — attempting bootstrap repair");
        const result = await repairLaunchAgentBootstrap({ env });
        if (result.ok) {
          return { ok: true, detail: "Re-bootstrapped LaunchAgent" };
        }
        return { ok: false, detail: `Bootstrap repair failed: ${result.detail ?? "unknown"}` };
      }
      // Loaded but not responding — try kickstart
      const { execFileUtf8 } = await import("../daemon/exec-file.js");
      const uid = process.getuid?.() ?? 501;
      const domain = `gui/${uid}`;
      const label = env.OPENCLAW_LAUNCHD_LABEL?.trim() || "ai.openclaw.gateway";
      const kick = await execFileUtf8("launchctl", ["kickstart", "-k", `${domain}/${label}`]);
      if (kick.code === 0) {
        return { ok: true, detail: "Kicked LaunchAgent" };
      }
      return { ok: false, detail: `Kickstart failed: ${(kick.stderr || kick.stdout).trim()}` };
    } catch (err) {
      return {
        ok: false,
        detail: `Repair error: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  if (process.platform === "linux") {
    try {
      const { execFileUtf8 } = await import("../daemon/exec-file.js");
      const unit = process.env.OPENCLAW_SYSTEMD_UNIT?.trim() || "openclaw-gateway.service";
      const restart = await execFileUtf8("systemctl", ["--user", "restart", unit]);
      if (restart.code === 0) {
        return { ok: true, detail: `Restarted systemd unit ${unit}` };
      }
      return {
        ok: false,
        detail: `systemctl restart failed: ${(restart.stderr || restart.stdout).trim()}`,
      };
    } catch (err) {
      return {
        ok: false,
        detail: `Repair error: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  return { ok: false, detail: `Unsupported platform: ${process.platform}` };
}

/**
 * Run a single watchdog cycle. Designed to be called from a cron job.
 *
 * 1. Probe gateway health
 * 2. If down: attempt repair, log, and return alert payload
 * 3. If up after previous downtime: return recovery payload
 * 4. If up and was up: return null (nothing to report)
 */
export async function runGatewayWatchdogCycle(): Promise<{
  status: "healthy" | "down" | "recovered";
  message: string;
} | null> {
  const state = readState();
  const healthy = await probeGateway();

  if (healthy) {
    const wasDown = Boolean(state.downSince);
    writeState({ lastHealthy: new Date().toISOString() });

    if (wasDown) {
      const downDuration = state.downSince
        ? formatDuration(Date.now() - new Date(state.downSince).getTime())
        : "unknown";
      const msg = `Gateway recovered. Was down for ${downDuration} (since ${state.downSince}).`;
      log.info(msg);
      return { status: "recovered", message: msg };
    }
    return null; // healthy, nothing to report
  }

  // Gateway is down
  log.warn("Gateway health probe failed");

  if (!state.downSince) {
    state.downSince = new Date().toISOString();
    state.alertSent = false;
  }

  // Attempt repair
  const repair = await attemptRepair();
  log.info({ ok: repair.ok, detail: repair.detail }, "Repair attempt result");

  // Wait a moment then re-probe
  await new Promise((r) => setTimeout(r, 5_000));
  const healthyAfterRepair = await probeGateway();

  if (healthyAfterRepair) {
    writeState({ lastHealthy: new Date().toISOString() });
    const msg = `Gateway was down — auto-repaired: ${repair.detail}`;
    log.info(msg);
    return { status: "recovered", message: msg };
  }

  // Still down
  writeState(state);
  const downDuration = formatDuration(Date.now() - new Date(state.downSince).getTime());
  const msg = [
    `Gateway is DOWN (${downDuration}).`,
    `Repair attempted: ${repair.detail}`,
    "Manual intervention may be required.",
  ].join("\n");
  log.error(msg);
  return { status: "down", message: msg };
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  const remainMins = minutes % 60;
  return `${hours}h${remainMins > 0 ? ` ${remainMins}m` : ""}`;
}
