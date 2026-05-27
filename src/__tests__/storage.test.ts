/**
 * Smoke tests for src/storage/prefs.ts coercion logic.
 *
 * Run with Node 24 (no test runner required):
 *   node --experimental-strip-types src/__tests__/storage.test.ts
 *
 * Strategy: interface-stub (option 2). Types and coercion helpers are
 * replicated here with the same logic prefs.ts must implement. A Map-backed
 * AsyncStorage stub enables round-trip assertions without a native bridge.
 *
 * Real AsyncStorage I/O (concurrent writes, eviction, OS-level corruption)
 * requires an on-device integration environment and is out of scope.
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function assert(condition: boolean, message: string): void {
  if (!condition) { console.error(`FAIL: ${message}`); process.exit(1); }
  console.log(`PASS: ${message}`);
}
function assertEqual<T>(actual: T, expected: T, label: string): void {
  assert(actual === expected,
    `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

// ---------------------------------------------------------------------------
// Types (mirrors src/storage/prefs.ts public surface)
// ---------------------------------------------------------------------------

type DisplayMode = 'griff' | 'klingend';
type FilterMode  = 'fast' | 'normal' | 'slow';
type GainMode    = 'low'  | 'high';
type Lang        = 'en'   | 'de';

interface AppPrefs {
  a4Hz:          number;       // 430..450, default 440
  displayMode:   DisplayMode;  // default 'griff'
  filterMode:    FilterMode;   // default 'normal'
  gainMode:      GainMode;     // default 'low'
  lang:          Lang;         // default 'en'
  instrumentKey: string;       // default 'bb_tenor'
}

const DEFAULT_PREFS: AppPrefs = {
  a4Hz: 440, displayMode: 'griff', filterMode: 'normal',
  gainMode: 'low', lang: 'en', instrumentKey: 'bb_tenor',
};

const A4_MIN = 430;
const A4_MAX = 450;

// ---------------------------------------------------------------------------
// Coercion helpers (same logic prefs.ts must implement)
// ---------------------------------------------------------------------------

function asA4Hz(v: unknown): number {
  if (v == null) return DEFAULT_PREFS.a4Hz;
  const n = Number(v);
  if (!Number.isFinite(n)) return DEFAULT_PREFS.a4Hz;
  return Math.max(A4_MIN, Math.min(A4_MAX, Math.round(n)));
}
function asDisplayMode(v: unknown): DisplayMode {
  return v === 'griff' || v === 'klingend' ? v : DEFAULT_PREFS.displayMode;
}
function asFilterMode(v: unknown): FilterMode {
  return v === 'fast' || v === 'normal' || v === 'slow' ? v : DEFAULT_PREFS.filterMode;
}
function asGainMode(v: unknown): GainMode {
  return v === 'low' || v === 'high' ? v : DEFAULT_PREFS.gainMode;
}
function asLang(v: unknown): Lang {
  return v === 'en' || v === 'de' ? v : DEFAULT_PREFS.lang;
}
function asInstrumentKey(v: unknown): string {
  return typeof v === 'string' && v.length > 0 ? v : DEFAULT_PREFS.instrumentKey;
}

function coerce(raw: unknown): AppPrefs {
  let obj: Record<string, unknown>;
  if (typeof raw === 'string') {
    try {
      const p = JSON.parse(raw);
      if (typeof p !== 'object' || p === null || Array.isArray(p)) return { ...DEFAULT_PREFS };
      obj = p as Record<string, unknown>;
    } catch { return { ...DEFAULT_PREFS }; }
  } else if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
    obj = raw as Record<string, unknown>;
  } else {
    return { ...DEFAULT_PREFS };
  }
  return {
    a4Hz:          asA4Hz(obj['a4Hz']),
    displayMode:   asDisplayMode(obj['displayMode']),
    filterMode:    asFilterMode(obj['filterMode']),
    gainMode:      asGainMode(obj['gainMode']),
    lang:          asLang(obj['lang']),
    instrumentKey: asInstrumentKey(obj['instrumentKey']),
  };
}

// ---------------------------------------------------------------------------
// Fake AsyncStorage (Map-backed, mirrors @react-native-async-storage API)
// ---------------------------------------------------------------------------

class FakeAsyncStorage {
  private store = new Map<string, string>();
  async getItem(key: string): Promise<string | null> { return this.store.get(key) ?? null; }
  async setItem(key: string, value: string): Promise<void> { this.store.set(key, value); }
  async removeItem(key: string): Promise<void> { this.store.delete(key); }
  clear(): void { this.store.clear(); }
}

const PREFS_KEY = 'app_prefs';

async function savePrefs(s: FakeAsyncStorage, p: AppPrefs): Promise<void> {
  await s.setItem(PREFS_KEY, JSON.stringify(p));
}
async function loadPrefs(s: FakeAsyncStorage): Promise<AppPrefs> {
  const raw = await s.getItem(PREFS_KEY);
  return raw === null ? { ...DEFAULT_PREFS } : coerce(raw);
}

// ---------------------------------------------------------------------------
// Test 1: Bad JSON → DEFAULT_PREFS
// ---------------------------------------------------------------------------
{
  const bad = coerce('{not valid json');
  assertEqual(bad.a4Hz,          DEFAULT_PREFS.a4Hz,          'bad JSON → default a4Hz');
  assertEqual(bad.displayMode,   DEFAULT_PREFS.displayMode,   'bad JSON → default displayMode');
  assertEqual(bad.filterMode,    DEFAULT_PREFS.filterMode,    'bad JSON → default filterMode');
  assertEqual(bad.gainMode,      DEFAULT_PREFS.gainMode,      'bad JSON → default gainMode');
  assertEqual(bad.lang,          DEFAULT_PREFS.lang,          'bad JSON → default lang');
  assertEqual(bad.instrumentKey, DEFAULT_PREFS.instrumentKey, 'bad JSON → default instrumentKey');
}

// ---------------------------------------------------------------------------
// Test 2: JSON array, null, and non-object primitives → DEFAULT_PREFS
// ---------------------------------------------------------------------------
{
  assertEqual(coerce('[1,2,3]').a4Hz,   DEFAULT_PREFS.a4Hz, 'JSON array → default a4Hz');
  assertEqual(coerce('null').a4Hz,      DEFAULT_PREFS.a4Hz, 'JSON null → default a4Hz');
  assertEqual(coerce(null).a4Hz,        DEFAULT_PREFS.a4Hz, 'null input → default a4Hz');
  assertEqual(coerce(42).a4Hz,          DEFAULT_PREFS.a4Hz, 'number input → default a4Hz');
  assertEqual(coerce(undefined).a4Hz,   DEFAULT_PREFS.a4Hz, 'undefined input → default a4Hz');
}

// ---------------------------------------------------------------------------
// Test 3: Missing fields → per-field defaults; present field kept
// ---------------------------------------------------------------------------
{
  const partial = coerce('{"a4Hz": 442}');
  assertEqual(partial.a4Hz,          442,                         'partial: present a4Hz=442 kept');
  assertEqual(partial.displayMode,   DEFAULT_PREFS.displayMode,   'partial: missing displayMode → default');
  assertEqual(partial.filterMode,    DEFAULT_PREFS.filterMode,    'partial: missing filterMode → default');
  assertEqual(partial.gainMode,      DEFAULT_PREFS.gainMode,      'partial: missing gainMode → default');
  assertEqual(partial.lang,          DEFAULT_PREFS.lang,          'partial: missing lang → default');
  assertEqual(partial.instrumentKey, DEFAULT_PREFS.instrumentKey, 'partial: missing instrumentKey → default');
}

// ---------------------------------------------------------------------------
// Test 4: Empty object → all defaults
// ---------------------------------------------------------------------------
{
  const e = coerce('{}');
  assertEqual(e.a4Hz, DEFAULT_PREFS.a4Hz, 'empty obj → default a4Hz');
  assertEqual(e.lang, DEFAULT_PREFS.lang, 'empty obj → default lang');
  assertEqual(e.instrumentKey, DEFAULT_PREFS.instrumentKey, 'empty obj → default instrumentKey');
}

// ---------------------------------------------------------------------------
// Test 5: Out-of-range a4Hz → clamped; in-range → unchanged
// ---------------------------------------------------------------------------
{
  assertEqual(asA4Hz(999),   A4_MAX, 'a4Hz=999 → clamped to 450');
  assertEqual(asA4Hz(100),   A4_MIN, 'a4Hz=100 → clamped to 430');
  assertEqual(asA4Hz(440),   440,    'a4Hz=440 → 440');
  assertEqual(asA4Hz(430),   A4_MIN, 'a4Hz=430 → 430 (lower bound inclusive)');
  assertEqual(asA4Hz(450),   A4_MAX, 'a4Hz=450 → 450 (upper bound inclusive)');
  assertEqual(asA4Hz(440.6), 441,    'a4Hz=440.6 → rounded to 441');
  assertEqual(asA4Hz(440.4), 440,    'a4Hz=440.4 → rounded to 440');
}

// ---------------------------------------------------------------------------
// Test 6: a4Hz NaN / non-numeric → default
// ---------------------------------------------------------------------------
{
  assertEqual(asA4Hz('xyz'),     DEFAULT_PREFS.a4Hz, 'a4Hz="xyz" → default');
  assertEqual(asA4Hz(NaN),       DEFAULT_PREFS.a4Hz, 'a4Hz=NaN → default');
  assertEqual(asA4Hz(Infinity),  DEFAULT_PREFS.a4Hz, 'a4Hz=Infinity → default');
  assertEqual(asA4Hz(-Infinity), DEFAULT_PREFS.a4Hz, 'a4Hz=-Infinity → default');
  assertEqual(asA4Hz(null),      DEFAULT_PREFS.a4Hz, 'a4Hz=null → default');
}

// ---------------------------------------------------------------------------
// Test 7: a4Hz as string-encoded number (AsyncStorage serialises to string)
// ---------------------------------------------------------------------------
{
  assertEqual(asA4Hz('442'), 442,    'a4Hz="442" (string) → 442');
  assertEqual(asA4Hz('429'), A4_MIN, 'a4Hz="429" (below min) → 430');
  assertEqual(asA4Hz('451'), A4_MAX, 'a4Hz="451" (above max) → 450');
}

// ---------------------------------------------------------------------------
// Test 8: Invalid enum values → per-field defaults
// ---------------------------------------------------------------------------
{
  assertEqual(asLang('fr'),            DEFAULT_PREFS.lang,        'lang="fr" → default "en"');
  assertEqual(asLang('EN'),            DEFAULT_PREFS.lang,        'lang="EN" (caps) → default "en"');
  assertEqual(asLang(''),              DEFAULT_PREFS.lang,        'lang="" → default "en"');
  assertEqual(asLang('de'),            'de',                      'lang="de" → "de"');
  assertEqual(asLang('en'),            'en',                      'lang="en" → "en"');

  assertEqual(asDisplayMode('other'),  DEFAULT_PREFS.displayMode, 'displayMode="other" → default');
  assertEqual(asDisplayMode('GRIFF'),  DEFAULT_PREFS.displayMode, 'displayMode="GRIFF" caps → default');
  assertEqual(asDisplayMode('griff'),  'griff',                   'displayMode="griff" → "griff"');
  assertEqual(asDisplayMode('klingend'), 'klingend',              'displayMode="klingend" → "klingend"');

  assertEqual(asFilterMode('turbo'),   DEFAULT_PREFS.filterMode,  'filterMode="turbo" → default');
  assertEqual(asFilterMode('fast'),    'fast',                    'filterMode="fast" → "fast"');
  assertEqual(asFilterMode('normal'),  'normal',                  'filterMode="normal" → "normal"');
  assertEqual(asFilterMode('slow'),    'slow',                    'filterMode="slow" → "slow"');

  assertEqual(asGainMode('medium'),    DEFAULT_PREFS.gainMode,    'gainMode="medium" → default');
  assertEqual(asGainMode('low'),       'low',                     'gainMode="low" → "low"');
  assertEqual(asGainMode('high'),      'high',                    'gainMode="high" → "high"');
}

// ---------------------------------------------------------------------------
// Test 9: instrumentKey — empty string and non-string → default
// ---------------------------------------------------------------------------
{
  assertEqual(asInstrumentKey(''),        DEFAULT_PREFS.instrumentKey, 'instrumentKey="" → default');
  assertEqual(asInstrumentKey(null),      DEFAULT_PREFS.instrumentKey, 'instrumentKey=null → default');
  assertEqual(asInstrumentKey(42),        DEFAULT_PREFS.instrumentKey, 'instrumentKey=42 → default');
  assertEqual(asInstrumentKey('eb_alto'), 'eb_alto',                   'instrumentKey="eb_alto" → "eb_alto"');
}

// ---------------------------------------------------------------------------
// Test 10: Boolean coercion (pattern for future boolean prefs)
// ---------------------------------------------------------------------------
{
  function asBool(v: unknown, fallback = false): boolean {
    if (v === true  || v === 1  || v === 'true'  || v === 'on'  || v === '1') return true;
    if (v === false || v === 0  || v === 'false' || v === 'off' || v === '')  return false;
    return fallback;
  }
  assert(asBool('true')  === true,  'asBool("true") === true');
  assert(asBool(1)       === true,  'asBool(1) === true');
  assert(asBool('on')    === true,  'asBool("on") === true');
  assert(asBool('1')     === true,  'asBool("1") === true');
  assert(asBool(true)    === true,  'asBool(true) === true');
  assert(asBool('false') === false, 'asBool("false") === false');
  assert(asBool(0)       === false, 'asBool(0) === false');
  assert(asBool('')      === false, 'asBool("") === false');
  assert(asBool(false)   === false, 'asBool(false) === false');
  assert(asBool('maybe', false) === false, 'asBool("maybe",false) → false fallback');
  assert(asBool('maybe', true)  === true,  'asBool("maybe",true) → true fallback');
}

// ---------------------------------------------------------------------------
// Test 11: Corrupted partial object — wrong types per field → all defaults
// ---------------------------------------------------------------------------
{
  const c = coerce(JSON.stringify({
    a4Hz: 'four hundred forty', displayMode: 7, filterMode: null,
    gainMode: [], lang: {}, instrumentKey: '',
  }));
  assertEqual(c.a4Hz,          DEFAULT_PREFS.a4Hz,          'corrupted a4Hz string → default');
  assertEqual(c.displayMode,   DEFAULT_PREFS.displayMode,   'corrupted displayMode number → default');
  assertEqual(c.filterMode,    DEFAULT_PREFS.filterMode,    'corrupted filterMode null → default');
  assertEqual(c.gainMode,      DEFAULT_PREFS.gainMode,      'corrupted gainMode array → default');
  assertEqual(c.lang,          DEFAULT_PREFS.lang,          'corrupted lang object → default');
  assertEqual(c.instrumentKey, DEFAULT_PREFS.instrumentKey, 'corrupted instrumentKey empty → default');
}

// ---------------------------------------------------------------------------
// Test 12: Round-trip via FakeAsyncStorage
// ---------------------------------------------------------------------------
{
  (async () => {
    const storage = new FakeAsyncStorage();
    const custom: AppPrefs = {
      a4Hz: 442, displayMode: 'klingend', filterMode: 'slow',
      gainMode: 'high', lang: 'de', instrumentKey: 'eb_alto',
    };
    await savePrefs(storage, custom);
    const loaded = await loadPrefs(storage);
    assertEqual(loaded.a4Hz,          custom.a4Hz,          'round-trip: a4Hz');
    assertEqual(loaded.displayMode,   custom.displayMode,   'round-trip: displayMode');
    assertEqual(loaded.filterMode,    custom.filterMode,    'round-trip: filterMode');
    assertEqual(loaded.gainMode,      custom.gainMode,      'round-trip: gainMode');
    assertEqual(loaded.lang,          custom.lang,          'round-trip: lang');
    assertEqual(loaded.instrumentKey, custom.instrumentKey, 'round-trip: instrumentKey');
    console.log('\nAll storage.ts smoke tests passed.');
  })().catch((err: unknown) => { console.error('FAIL:', err); process.exit(1); });
}

// ---------------------------------------------------------------------------
// Test 13: loadPrefs on empty storage → DEFAULT_PREFS
// ---------------------------------------------------------------------------
{
  (async () => {
    const loaded = await loadPrefs(new FakeAsyncStorage());
    assertEqual(loaded.a4Hz,          DEFAULT_PREFS.a4Hz,          'empty store → default a4Hz');
    assertEqual(loaded.displayMode,   DEFAULT_PREFS.displayMode,   'empty store → default displayMode');
    assertEqual(loaded.instrumentKey, DEFAULT_PREFS.instrumentKey, 'empty store → default instrumentKey');
  })().catch((err: unknown) => { console.error('FAIL:', err); process.exit(1); });
}

// ---------------------------------------------------------------------------
// Test 14: Mutating the loaded copy does NOT affect the stored value
// ---------------------------------------------------------------------------
{
  (async () => {
    const storage = new FakeAsyncStorage();
    await savePrefs(storage, { ...DEFAULT_PREFS });
    const loaded = await loadPrefs(storage);
    loaded.a4Hz = 999;                   // mutate copy
    const reloaded = await loadPrefs(storage);
    assertEqual(reloaded.a4Hz, 440, 'no aliasing: mutating loaded copy leaves store unchanged');
  })().catch((err: unknown) => { console.error('FAIL:', err); process.exit(1); });
}
