import AsyncStorage from '@react-native-async-storage/async-storage';

const OVERRIDES_KEY = '@intonation/range_overrides';
// Schema envelope matches desktop's instrument_ranges.json for future cross-sync.
const SCHEMA_VERSION = 1;

export interface RangeOverride {
  lo: number;
  hi: number;
}

interface StorageEnvelope {
  version: number;
  ranges: Record<string, [number, number]>;
}

function isValidRange(lo: number, hi: number): boolean {
  return (
    Number.isInteger(lo) && Number.isInteger(hi) &&
    lo >= 0 && lo <= 127 && hi >= 0 && hi <= 127 && lo <= hi
  );
}

async function readEnvelope(): Promise<Record<string, [number, number]>> {
  try {
    const raw = await AsyncStorage.getItem(OVERRIDES_KEY);
    if (raw == null) return {};
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { return {}; }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    const env = parsed as Partial<StorageEnvelope>;
    if (typeof env.ranges !== 'object' || env.ranges === null) return {};
    const out: Record<string, [number, number]> = {};
    for (const [key, val] of Object.entries(env.ranges)) {
      if (!Array.isArray(val) || val.length !== 2) continue;
      const lo = Number(val[0]);
      const hi = Number(val[1]);
      if (!isValidRange(lo, hi)) continue;
      out[key] = [lo, hi];
    }
    return out;
  } catch {
    return {};
  }
}

async function writeEnvelope(ranges: Record<string, [number, number]>): Promise<void> {
  const envelope: StorageEnvelope = { version: SCHEMA_VERSION, ranges };
  await AsyncStorage.setItem(OVERRIDES_KEY, JSON.stringify(envelope));
}

export async function loadRangeOverrides(): Promise<Record<string, RangeOverride>> {
  const raw = await readEnvelope();
  const out: Record<string, RangeOverride> = {};
  for (const [key, [lo, hi]] of Object.entries(raw)) {
    out[key] = { lo, hi };
  }
  return out;
}

export async function saveRangeOverride(
  instrumentKey: string,
  lo: number,
  hi: number,
): Promise<void> {
  if (!isValidRange(lo, hi)) return;
  try {
    const current = await readEnvelope();
    current[instrumentKey] = [lo, hi];
    await writeEnvelope(current);
  } catch {
    // Best-effort.
  }
}

export async function clearRangeOverride(instrumentKey: string): Promise<void> {
  try {
    const current = await readEnvelope();
    if (!(instrumentKey in current)) return;
    delete current[instrumentKey];
    await writeEnvelope(current);
  } catch {
    // Best-effort.
  }
}

export async function clearAllRangeOverrides(): Promise<void> {
  try {
    await AsyncStorage.removeItem(OVERRIDES_KEY);
  } catch {
    // Best-effort.
  }
}
