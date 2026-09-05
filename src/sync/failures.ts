import { bumpFailure, clearFailure } from '../db/state.js';

// A record is retried across runs up to MAX_RETRIES times; after that it is
// declared "dead" and stops holding the watermark back, so one permanently-bad
// record can't force the sync to reprocess the whole backlog forever.
export const MAX_RETRIES = Number(process.env.MAX_FAIL_RETRIES ?? 5);

export interface FailTracker {
  errors: number; // live (still-retrying) failures this run
  dead: number; // records skipped after exceeding MAX_RETRIES
  earliestFailure: string | null; // YYYY-MM-DD of the oldest live failure
}

export function newFailTracker(): FailTracker {
  return { errors: 0, dead: 0, earliestFailure: null };
}

function msg(err: unknown): string {
  return err instanceof Error ? `${err.constructor.name}: ${err.message}` : String(err);
}

/**
 * Record a failed item. `dateIso` (YYYY-MM-DD) is the record's date; the
 * watermark will resume from the oldest live failure so earlier, already-synced
 * records are not reprocessed. Once an item exceeds MAX_RETRIES it becomes dead
 * and no longer holds the watermark.
 */
export function noteFailure(t: FailTracker, key: string, dateIso: string, err: unknown): void {
  const m = msg(err);
  const attempts = bumpFailure(key, m);
  if (attempts >= MAX_RETRIES) {
    console.error(`[dead] ${key} skipped after ${attempts} attempts: ${m}`);
    t.dead++;
    return;
  }
  t.errors++;
  const day = dateIso.slice(0, 10);
  if (t.earliestFailure === null || day < t.earliestFailure) t.earliestFailure = day;
  console.error(`[fail] ${key} (attempt ${attempts}): ${m}`);
}

/** Clear a record's failure history after it syncs successfully. */
export function noteSuccess(key: string): void {
  clearFailure(key);
}
