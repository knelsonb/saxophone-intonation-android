import { openDatabaseAsync } from 'expo-sqlite';
import type { SQLiteDatabase } from 'expo-sqlite';

// SQRT absent in default Android/expo-sqlite build. stdCents computed in JS
// from AVG(cents) and AVG(cents*cents) that SQLite does return.
const DB_NAME = 'intonation.db';

let _db: SQLiteDatabase | null = null;

async function getDb(): Promise<SQLiteDatabase> {
  if (_db == null) {
    _db = await openDatabaseAsync(DB_NAME);
  }
  return _db;
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const DDL = `
CREATE TABLE IF NOT EXISTS measurements (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id      TEXT NOT NULL,
  ts          TEXT NOT NULL,
  instrument  TEXT NOT NULL,
  a4_hz       REAL NOT NULL,
  midi_sound  INTEGER NOT NULL,
  midi_fing   INTEGER NOT NULL,
  cents       REAL NOT NULL,
  freq_hz     REAL NOT NULL,
  student_id  TEXT
);
CREATE TABLE IF NOT EXISTS runs (
  run_id      TEXT PRIMARY KEY,
  started_at  TEXT NOT NULL,
  instrument  TEXT NOT NULL,
  a4_hz       REAL NOT NULL,
  nickname    TEXT NOT NULL DEFAULT '',
  student_id  TEXT
);
CREATE INDEX IF NOT EXISTS idx_meas_instr_midi ON measurements(instrument, midi_sound);
CREATE INDEX IF NOT EXISTS idx_meas_student ON measurements(student_id);
`;

// In-place migration for installs that pre-date the student_id column.
// ALTER TABLE ADD COLUMN is not idempotent in SQLite, so we attempt the add
// and swallow "duplicate column" errors. Fresh installs already get the column
// via the CREATE TABLE above; this is the upgrade-from-v0.6.x path.
async function migrateSchema(db: SQLiteDatabase): Promise<void> {
  const attempts = [
    'ALTER TABLE measurements ADD COLUMN student_id TEXT',
    'ALTER TABLE runs         ADD COLUMN student_id TEXT',
  ];
  for (const sql of attempts) {
    try {
      await db.execAsync(sql);
    } catch {
      // Column already exists, or table missing entirely — either way the
      // CREATE TABLE IF NOT EXISTS above ran first and is authoritative.
    }
  }
}

export async function initMeasurementsDb(): Promise<void> {
  try {
    const db = await getDb();
    await db.execAsync(DDL);
    await migrateSchema(db);
  } catch {
    // Schema errors must not crash the app.
  }
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface MeasurementInsert {
  runId: string;
  ts: string;
  instrument: string;
  a4Hz: number;
  midiSound: number;
  midiFing: number;
  cents: number;
  freqHz: number;
  /** Optional — null/undefined means "no student selected". */
  studentId?: string | null;
}

export interface AggregatedNote {
  midiFing: number;
  meanCents: number;
  stdCents: number;
  n: number;
  freqHz: number;
}

// ---------------------------------------------------------------------------
// Run management
// ---------------------------------------------------------------------------

export async function startRun(args: {
  instrument: string;
  a4Hz: number;
  nickname: string;
  studentId?: string | null;
}): Promise<string> {
  // runId generation matches desktop uuid4().hex[:12] style — short, unique enough for local use.
  const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const startedAt = new Date().toISOString();
  try {
    const db = await getDb();
    await db.runAsync(
      'INSERT INTO runs (run_id, started_at, instrument, a4_hz, nickname, student_id) VALUES (?, ?, ?, ?, ?, ?)',
      [runId, startedAt, args.instrument, args.a4Hz, args.nickname, args.studentId ?? null],
    );
  } catch {
    // Best-effort; return the generated id regardless so the caller has a ref.
  }
  return runId;
}

// ---------------------------------------------------------------------------
// Measurement intake
// ---------------------------------------------------------------------------

export async function insertMeasurement(m: MeasurementInsert): Promise<void> {
  try {
    const db = await getDb();
    await db.runAsync(
      `INSERT INTO measurements
         (run_id, ts, instrument, a4_hz, midi_sound, midi_fing, cents, freq_hz, student_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [m.runId, m.ts, m.instrument, m.a4Hz, m.midiSound, m.midiFing, m.cents, m.freqHz, m.studentId ?? null],
    );
  } catch {
    // Drop silently; a missed measurement is never worth a crash.
  }
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

// Raw row shape returned by SQLite before JS post-processing.
interface AggRow {
  midiFing: number;
  meanCents: number;
  meanCentsSq: number;  // AVG(cents * cents) — used to compute variance in JS
  n: number;
  freqHz: number;
}

export async function aggregateNotes(args: {
  instrument: string;
  a4Hz: number;
  minN: number;
  /**
   * Optional ISO-8601 lower bound on `ts`. When supplied, only measurements
   * whose `ts > sinceTs` are aggregated. The Table screen uses this to
   * drive the "Last 2s" view: pass `new Date(Date.now() - 2000).toISOString()`
   * before each tick. Omit (or pass null) for the cumulative session view.
   */
  sinceTs?: string | null;
}): Promise<AggregatedNote[]> {
  try {
    const db = await getDb();
    // Pull AVG(cents) and AVG(cents*cents) from SQLite; compute stdCents in JS.
    // This avoids the SQRT dependency (see top-of-file note).
    // Filter on the measurement's own a4_hz, not the parent run's a4_hz.
    // Earlier versions joined through runs.a4_hz, which froze at run start —
    // bumping A4 mid-session would silently mis-bucket samples (or hide them
    // entirely when querying at the new A4). Each measurement now carries
    // its live a4_hz, so the filter is precise without re-opening a run.
    //
    // sinceTs: optional time filter for the "Last 2s" Table view. We compare
    // ISO-8601 strings — they sort lexically the same as chronologically when
    // both use the same offset, and we always insert as `new Date().toISOString()`
    // so the comparison is sound.
    const sinceTs = args.sinceTs ?? null;
    const rows = sinceTs === null
      ? await db.getAllAsync<AggRow>(
          `SELECT
             midi_fing        AS midiFing,
             AVG(cents)       AS meanCents,
             AVG(cents*cents) AS meanCentsSq,
             COUNT(*)         AS n,
             AVG(freq_hz)     AS freqHz
           FROM measurements
           WHERE instrument = ?
             AND a4_hz      = ?
           GROUP BY midi_fing
           HAVING COUNT(*) >= ?
           ORDER BY midi_fing`,
          [args.instrument, args.a4Hz, args.minN],
        )
      : await db.getAllAsync<AggRow>(
          `SELECT
             midi_fing        AS midiFing,
             AVG(cents)       AS meanCents,
             AVG(cents*cents) AS meanCentsSq,
             COUNT(*)         AS n,
             AVG(freq_hz)     AS freqHz
           FROM measurements
           WHERE instrument = ?
             AND a4_hz      = ?
             AND ts         > ?
           GROUP BY midi_fing
           HAVING COUNT(*) >= ?
           ORDER BY midi_fing`,
          [args.instrument, args.a4Hz, sinceTs, args.minN],
        );

    return rows.map((row) => {
      // Population std dev: sqrt(E[X^2] - E[X]^2), clamped to >= 0 before sqrt
      // to guard against floating-point rounding producing tiny negatives.
      // The Number.isFinite() guards protect aggregations against a single
      // garbage row poisoning the cell with NaN.
      const variance = Math.max(0, row.meanCentsSq - row.meanCents * row.meanCents);
      const std = Math.sqrt(variance);
      return {
        midiFing:  row.midiFing,
        meanCents: Number.isFinite(row.meanCents) ? row.meanCents : 0,
        stdCents:  row.n < 2 || !Number.isFinite(std) ? 0 : std,
        n:         row.n,
        freqHz:    Number.isFinite(row.freqHz) ? row.freqHz : 0,
      };
    });
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Clear
// ---------------------------------------------------------------------------

export async function clearMeasurements(instrument?: string): Promise<void> {
  try {
    const db = await getDb();
    if (instrument == null) {
      await db.execAsync('DELETE FROM measurements; DELETE FROM runs;');
    } else {
      await db.runAsync(
        'DELETE FROM measurements WHERE instrument = ?',
        [instrument],
      );
      // Remove runs that now have no measurements.
      await db.runAsync(
        `DELETE FROM runs WHERE instrument = ?
           AND run_id NOT IN (SELECT DISTINCT run_id FROM measurements)`,
        [instrument],
      );
    }
  } catch {
    // Best-effort.
  }
}
