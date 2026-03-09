import type { RuntimeEnv } from "../runtime.js";
import { openMiaDb, resolveMiaDbDir, seedDefaultTasks } from "./mia-store.js";

/**
 * Initialize the Mia task queue: create the DB directory, schema, and seed
 * default task definitions. Safe to call multiple times (idempotent).
 *
 * Returns `{ dir }` on success, or `null` if node:sqlite is unavailable.
 */
export function ensureMiaDb(runtime?: RuntimeEnv): { dir: string } | null {
  const dir = resolveMiaDbDir();
  const db = openMiaDb(dir);
  if (!db) {
    runtime?.log("Mia DB skipped (node:sqlite unavailable)");
    return null;
  }
  const seeded = seedDefaultTasks(db);
  if (seeded > 0) {
    runtime?.log(`Mia: seeded ${seeded} default task definition(s)`);
  }
  return { dir };
}
