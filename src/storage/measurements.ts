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
  freq_hz     REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS runs (
  run_id      TEXT PRIMARY KEY,
  started_at  TEXT NOT NULL,
  instrument  TEXT NOT NULL,
  a4_hz       REAL NOT NULL,
  nickname    TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_meas_instr_midi ON measurements(instrument, midi_sound);
`;

export async function initMeasurementsDb(): Promise<void> {
  try {
    const db = await getDb();
    await db.execAsync(DDL);
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
}): Promise<string> {
  // runId generation matches desktop uuid4().hex[:12] style — short, unique enough for local use.
  const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const startedAt = new Date().toISOString();
  try {
    const db = await getDb();
    await db.runAsync(
      'INSERT INTO runs (run_id, started_at, instrument, a4_hz, nickname) VALUES (?, ?, ?, ?, ?)',
      [runId, startedAt, args.instrument, args.a4Hz, args.nickname],
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
         (run_id, ts, instrument, a4_hz, midi_sound, midi_fing, cents, freq_hz)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [m.runId, m.ts, m.instrument, m.a4Hz, m.midiSound, m.midiFing, m.cents, m.freqHz],
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
}): Promise<AggregatedNote[]> {
  try {
    const db = await getDb();
    // Pull AVG(cents) and AVG(cents*cents) from SQLite; compute stdCents in JS.
    // This avoids the SQRT dependency (see top-of-file note).
    const rows = await db.getAllAsync<AggRow>(
      `SELECT
         midi_fing        AS midiFing,
         AVG(cents)       AS meanCents,
         AVG(cents*cents) AS meanCentsSq,
         COUNT(*)         AS n,
         AVG(freq_hz)     AS freqHz
       FROM measurements
       WHERE instrument = ?
         AND run_id IN (
               SELECT run_id FROM runs
               WHERE instrument = ? AND a4_hz = ?
             )
       GROUP BY midi_fing
       HAVING COUNT(*) >= ?
       ORDER BY midi_fing`,
      [args.instrument, args.instrument, args.a4Hz, args.minN],
    );

    return rows.map((row) => {
      // Population std dev: sqrt(E[X^2] - E[X]^2), clamped to >= 0 before sqrt
      // to guard against floating-point rounding producing tiny negatives.
      const variance = Math.max(0, row.meanCentsSq - row.meanCents * row.meanCents);
      return {
        midiFing:  row.midiFing,
        meanCents: row.meanCents,
        stdCents:  row.n < 2 ? 0 : Math.sqrt(variance),
        n:         row.n,
        freqHz:    row.freqHz,
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
