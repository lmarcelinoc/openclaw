/**
 * Alert state tracking with exponential backoff.
 * Prevents repeated alerts for the same persistent failure.
 *
 * State file: ~/.openclaw/diag/alert-state.json
 * Initial backoff: 5 min, doubles each fire, caps at 24 h.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { CONFIG_DIR } from "../../utils.js";

const ALERT_STATE_PATH = path.join(CONFIG_DIR, "diag", "alert-state.json");

const INITIAL_BACKOFF_MS = 5 * 60_000; // 5 min
const MAX_BACKOFF_MS = 24 * 60 * 60_000; // 24 h

type AlertRecord = {
  lastAlertAtMs: number;
  backoffMs: number;
};

type AlertStateFile = {
  alerts: Record<string, AlertRecord>;
};

async function readAlertState(): Promise<AlertStateFile> {
  try {
    const raw = await fs.readFile(ALERT_STATE_PATH, "utf-8");
    return JSON.parse(raw) as AlertStateFile;
  } catch {
    return { alerts: {} };
  }
}

async function writeAlertState(state: AlertStateFile): Promise<void> {
  await fs.mkdir(path.dirname(ALERT_STATE_PATH), { recursive: true });
  await fs.writeFile(ALERT_STATE_PATH, JSON.stringify(state, null, 2) + "\n", {
    encoding: "utf-8",
    mode: 0o600,
  });
}

/** Returns true if enough time has elapsed since the last alert (or no alert yet). */
export async function shouldAlert(key: string): Promise<boolean> {
  const state = await readAlertState();
  const record = state.alerts[key];
  if (!record) {
    return true;
  }
  return Date.now() >= record.lastAlertAtMs + record.backoffMs;
}

/** Record that an alert fired now; advances the backoff for next time. */
export async function recordAlert(key: string): Promise<void> {
  const state = await readAlertState();
  const existing = state.alerts[key];
  const prevBackoff = existing?.backoffMs ?? 0;
  const nextBackoff =
    prevBackoff === 0 ? INITIAL_BACKOFF_MS : Math.min(prevBackoff * 2, MAX_BACKOFF_MS);
  state.alerts[key] = { lastAlertAtMs: Date.now(), backoffMs: nextBackoff };
  await writeAlertState(state);
}

/** Clear alert state when the condition resolves (resets backoff). */
export async function clearAlert(key: string): Promise<void> {
  const state = await readAlertState();
  if (state.alerts[key]) {
    delete state.alerts[key];
    await writeAlertState(state);
  }
}

/** List all active (still-in-backoff) alert keys and their next-alert time. */
export async function listActiveAlerts(): Promise<
  Array<{ key: string; nextAlertAt: Date; backoffMs: number }>
> {
  const state = await readAlertState();
  const now = Date.now();
  return Object.entries(state.alerts)
    .filter(([, rec]) => now < rec.lastAlertAtMs + rec.backoffMs)
    .map(([key, rec]) => ({
      key,
      nextAlertAt: new Date(rec.lastAlertAtMs + rec.backoffMs),
      backoffMs: rec.backoffMs,
    }));
}
