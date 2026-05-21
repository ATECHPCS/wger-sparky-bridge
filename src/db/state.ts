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
  `);
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
