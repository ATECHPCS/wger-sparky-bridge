import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

const DATA_DIR = process.env.DATA_DIR ?? './data';
const DB_PATH = path.join(DATA_DIR, 'sync.db');

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!_db) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    _db = new Database(DB_PATH);
    _db.pragma('journal_mode = WAL');
    migrate(_db);
  }
  return _db;
}

function migrate(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sync_log (
      source      TEXT NOT NULL,
      source_id   TEXT NOT NULL,
      data_type   TEXT NOT NULL,
      synced_at   TEXT NOT NULL,
      PRIMARY KEY (source, source_id, data_type)
    );

    CREATE TABLE IF NOT EXISTS state (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS fail_log (
      key        TEXT PRIMARY KEY,
      attempts   INTEGER NOT NULL,
      last_error TEXT,
      updated_at TEXT NOT NULL
    );

    -- Weight check-ins rejected by the anomaly guard (see sync/weight-guard.ts).
    -- Quarantined dates are never pushed and never re-alert.
    CREATE TABLE IF NOT EXISTS weight_quarantine (
      date        TEXT PRIMARY KEY,
      value       REAL NOT NULL,
      reason      TEXT NOT NULL,
      created_at  TEXT NOT NULL
    );

    -- All-time best estimated 1RM per exercise, for PR detection.
    CREATE TABLE IF NOT EXISTS pr_best (
      exercise_id INTEGER PRIMARY KEY,
      best_1rm    REAL NOT NULL,
      best_weight REAL NOT NULL,
      best_reps   INTEGER NOT NULL,
      date        TEXT NOT NULL,
      updated_at  TEXT NOT NULL
    );

    -- One row per detected PR event, used to build the weekly digest.
    CREATE TABLE IF NOT EXISTS pr_event (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      exercise_id   INTEGER NOT NULL,
      exercise_name TEXT NOT NULL,
      weight        REAL NOT NULL,
      reps          INTEGER NOT NULL,
      est_1rm       REAL NOT NULL,
      prev_1rm      REAL NOT NULL,
      date          TEXT NOT NULL,
      created_at    TEXT NOT NULL
    );
  `);
}

// Weight anomaly quarantine ----------------------------------------------

export function isWeightQuarantined(date: string): boolean {
  return (
    getDb().prepare('SELECT 1 FROM weight_quarantine WHERE date = ?').get(date) !== undefined
  );
}

/** Record a rejected weight. Returns true only if this date was newly added
 * (so the caller alerts exactly once per anomalous date). */
export function quarantineWeight(date: string, value: number, reason: string): boolean {
  const res = getDb()
    .prepare(
      'INSERT OR IGNORE INTO weight_quarantine (date, value, reason, created_at) VALUES (?, ?, ?, ?)',
    )
    .run(date, value, reason, new Date().toISOString());
  return res.changes > 0;
}

// PR tracking ------------------------------------------------------------

export interface PrBest {
  exercise_id: number;
  best_1rm: number;
  best_weight: number;
  best_reps: number;
  date: string;
}

export function getPrBest(exerciseId: number): PrBest | undefined {
  return getDb().prepare('SELECT * FROM pr_best WHERE exercise_id = ?').get(exerciseId) as
    | PrBest
    | undefined;
}

export function setPrBest(b: PrBest): void {
  getDb()
    .prepare(
      `INSERT INTO pr_best (exercise_id, best_1rm, best_weight, best_reps, date, updated_at)
       VALUES (@exercise_id, @best_1rm, @best_weight, @best_reps, @date, @updated_at)
       ON CONFLICT(exercise_id) DO UPDATE SET
         best_1rm=@best_1rm, best_weight=@best_weight, best_reps=@best_reps,
         date=@date, updated_at=@updated_at`,
    )
    .run({ ...b, updated_at: new Date().toISOString() });
}

export interface PrEvent {
  exercise_id: number;
  exercise_name: string;
  weight: number;
  reps: number;
  est_1rm: number;
  prev_1rm: number;
  date: string;
}

export function recordPrEvent(e: PrEvent): void {
  getDb()
    .prepare(
      `INSERT INTO pr_event
        (exercise_id, exercise_name, weight, reps, est_1rm, prev_1rm, date, created_at)
       VALUES (@exercise_id, @exercise_name, @weight, @reps, @est_1rm, @prev_1rm, @date, @created_at)`,
    )
    .run({ ...e, created_at: new Date().toISOString() });
}

export function getRecentPrEvents(sinceIso: string): PrEvent[] {
  return getDb()
    .prepare('SELECT * FROM pr_event WHERE date >= ? ORDER BY date DESC')
    .all(sinceIso) as PrEvent[];
}

// Per-record failure tracking so a permanently-bad record can be retried a
// bounded number of times and then skipped (see sync/failures.ts).
export function bumpFailure(key: string, error: string): number {
  const db = getDb();
  const row = db.prepare('SELECT attempts FROM fail_log WHERE key = ?').get(key) as
    | { attempts: number }
    | undefined;
  const attempts = (row?.attempts ?? 0) + 1;
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO fail_log (key, attempts, last_error, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET attempts = ?, last_error = ?, updated_at = ?`,
  ).run(key, attempts, error.slice(0, 300), now, attempts, error.slice(0, 300), now);
  return attempts;
}

export function clearFailure(key: string): void {
  getDb().prepare('DELETE FROM fail_log WHERE key = ?').run(key);
}

export function isSynced(source: string, sourceId: string, dataType: string): boolean {
  const db = getDb();
  const row = db
    .prepare('SELECT 1 FROM sync_log WHERE source = ? AND source_id = ? AND data_type = ?')
    .get(source, sourceId, dataType);
  return row !== undefined;
}

export function markSynced(source: string, sourceId: string, dataType: string): void {
  const db = getDb();
  db.prepare(
    'INSERT OR IGNORE INTO sync_log (source, source_id, data_type, synced_at) VALUES (?, ?, ?, ?)',
  ).run(source, sourceId, dataType, new Date().toISOString());
}

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

export function getLastSyncTs(): Date {
  const db = getDb();
  const row = db.prepare('SELECT value FROM state WHERE key = ?').get('last_sync_ts') as
    | { value: string }
    | undefined;
  if (row) {
    const ts = new Date(row.value);
    if (Number.isFinite(ts.getTime())) return ts;
    console.warn('[state] corrupt last_sync_ts, falling back to 30-day default');
  }
  return new Date(Date.now() - THIRTY_DAYS_MS);
}

export function setLastSyncTs(ts: Date): void {
  const db = getDb();
  db.prepare('INSERT OR REPLACE INTO state (key, value) VALUES (?, ?)').run(
    'last_sync_ts',
    ts.toISOString(),
  );
}
