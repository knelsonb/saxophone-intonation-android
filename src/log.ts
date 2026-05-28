/**
 * BellCurve — forensic ring-buffer logger.
 *
 * 200-entry in-memory ring buffer.  On every .e() call the buffer is also
 * persisted to AsyncStorage so a crash leaves the tail visible on the next
 * launch via loadLastSession().
 *
 * All levels mirror to the corresponding console method so logcat picks them
 * up through React Native's bridge with the format "[tag] msg args".
 *
 * Args are best-effort JSON-stringified with a circular-safe replacer and
 * truncated to 2 KB per entry.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  ts: number;
  level: LogLevel;
  tag: string;
  msg: string;
}

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

const STORAGE_KEY = '@bellcurve/log/ring';
const MAX_ENTRIES = 200;
const MAX_ARG_BYTES = 2048;

const ring: LogEntry[] = [];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** JSON.stringify with a simple circular-reference guard. */
function safeStringify(v: unknown): string {
  const seen = new WeakSet<object>();
  try {
    return JSON.stringify(v, (_key, val) => {
      if (typeof val === 'object' && val !== null) {
        if (seen.has(val)) return '[Circular]';
        seen.add(val);
      }
      return val as unknown;
    });
  } catch {
    return String(v);
  }
}

/** Format extra args as a space-separated string, truncated at MAX_ARG_BYTES. */
function formatArgs(args: unknown[]): string {
  if (args.length === 0) return '';
  const parts: string[] = [];
  for (const a of args) {
    if (typeof a === 'string') {
      parts.push(a);
    } else {
      parts.push(safeStringify(a));
    }
  }
  const joined = ' ' + parts.join(' ');
  return joined.length > MAX_ARG_BYTES ? joined.slice(0, MAX_ARG_BYTES) + '…' : joined;
}

function push(level: LogLevel, tag: string, msg: string): void {
  const entry: LogEntry = { ts: Date.now(), level, tag, msg };
  ring.push(entry);
  if (ring.length > MAX_ENTRIES) {
    ring.shift();
  }
}

// v1.4.x P1 — native logcat passthrough. RN release builds do NOT pipe
// console.* to logcat (that routing is __DEV__-gated), so on-device forensics
// were invisible to `adb logcat`. Mirror entries into Android's native log via
// the synth module's nativeLog Function. Resolved lazily + guarded so the Node
// test runner (no native module) never breaks on import. Debug level is NOT
// mirrored — it fires per audio op (per-beat or more) and would flood logcat;
// warn/info/error carry the diagnostics worth surfacing in the field.
let nativeLogFn: ((level: string, tag: string, msg: string) => void) | null | undefined;
function nativeLog(level: LogLevel, tag: string, msg: string): void {
  if (level === 'debug') return; // gentle: skip per-op spam
  if (nativeLogFn === undefined) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const mod = require('@local/raw-audio-output');
      const s = (mod && (mod.default ?? mod)) as
        | { nativeLog?: (l: string, t: string, m: string) => void }
        | undefined;
      nativeLogFn = typeof s?.nativeLog === 'function'
        ? (l, t, m) => s.nativeLog!(l, t, m)
        : null;
    } catch {
      nativeLogFn = null;
    }
  }
  if (nativeLogFn) {
    try { nativeLogFn(level, tag, msg); } catch { /* best-effort */ }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export const log = {

  d(tag: string, msg: string, ...args: unknown[]): void {
    const full = msg + formatArgs(args);
    push('debug', tag, full);
    console.log(`[${tag}] ${full}`);
  },

  i(tag: string, msg: string, ...args: unknown[]): void {
    const full = msg + formatArgs(args);
    push('info', tag, full);
    console.log(`[${tag}] ${full}`);
    nativeLog('info', tag, full);
  },

  w(tag: string, msg: string, ...args: unknown[]): void {
    const full = msg + formatArgs(args);
    push('warn', tag, full);
    console.warn(`[${tag}] ${full}`);
    nativeLog('warn', tag, full);
  },

  e(tag: string, msg: string, ...args: unknown[]): void {
    const full = msg + formatArgs(args);
    push('error', tag, full);
    console.error(`[${tag}] ${full}`);
    nativeLog('error', tag, full);
    // Fire-and-forget persist — crash leaves persisted tail.
    log.flushAsync().catch(() => {});
  },

  /** Returns the last N entries in chronological order (oldest first). */
  recent(n: number = MAX_ENTRIES): readonly LogEntry[] {
    if (n >= ring.length) return ring.slice();
    return ring.slice(ring.length - n);
  },

  /** Reads the persisted ring buffer from the last session (pre-crash tail). */
  async loadLastSession(): Promise<readonly LogEntry[]> {
    try {
      const raw = await AsyncStorage.getItem(STORAGE_KEY);
      if (raw == null) return [];
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      // Validate shape — drop any malformed entries so callers can trust types.
      const entries: LogEntry[] = [];
      for (const item of parsed) {
        if (
          typeof item === 'object' &&
          item !== null &&
          typeof (item as Record<string, unknown>).ts === 'number' &&
          typeof (item as Record<string, unknown>).level === 'string' &&
          typeof (item as Record<string, unknown>).tag === 'string' &&
          typeof (item as Record<string, unknown>).msg === 'string'
        ) {
          entries.push(item as LogEntry);
        }
      }
      return entries;
    } catch {
      return [];
    }
  },

  /** Persist current ring to AsyncStorage. Called automatically by .e(). */
  async flushAsync(): Promise<void> {
    try {
      const snapshot = ring.slice();
      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
    } catch {
      // Best-effort. Never throw — we're often inside a crash handler.
    }
  },
};
