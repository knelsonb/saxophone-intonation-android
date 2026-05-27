/**
 * droneVoices.ts — voice catalog for the v1.1 TSF-backed drone.
 *
 * Two tiers:
 *   - DRONE_PRESETS — five curated picks shown as the top row in SETUP.
 *   - DRONE_FULL_GM — the full GM 128 patch list for the "More voices" tray.
 *
 * `id` is the stable persisted key (used in AppPrefs.droneVoice). Preset ids
 * are short tokens that NEVER collide with `gm-N` (which is reserved for the
 * full-GM list). `program` is the GM patch number (0..127), bank 0.
 *
 * The drone is hard-wired to MIDI channel 0; voices may carry an explicit
 * `channel` override but none do today.
 */

export interface DroneVoice {
  id: string;            // stable persisted key, e.g. 'organ', 'sax-tenor', or 'gm-19'
  label: string;         // display label, e.g. 'Organ', 'Tenor Sax', 'Church Organ'
  program: number;       // GM patch 0..127
  channel?: number;      // MIDI channel — default 0 (drone)
}

// 5-up preset row — the curated picks shown at the top of SETUP.
// Short ids chosen to NEVER collide with the 'gm-N' namespace below.
export const DRONE_PRESETS: readonly DroneVoice[] = [
  { id: 'organ',     label: 'Organ',      program: 19 }, // Church Organ
  { id: 'strings',   label: 'Strings',    program: 48 }, // String Ensemble 1
  { id: 'cello',     label: 'Cello',      program: 42 }, // Cello
  { id: 'sax-tenor', label: 'Tenor Sax',  program: 66 }, // Tenor Sax
  { id: 'pad-warm',  label: 'Warm Pad',   program: 89 }, // Pad 2 (Warm)
] as const;

// Canonical GM 1 patch names, 0..127, in program-number order.
// Reference: MMA General MIDI 1 spec (1991).
const GM_NAMES: readonly string[] = [
  // Piano (0–7)
  'Acoustic Grand Piano', 'Bright Acoustic Piano', 'Electric Grand Piano', 'Honky-tonk Piano',
  'Electric Piano 1', 'Electric Piano 2', 'Harpsichord', 'Clavinet',
  // Chromatic Percussion (8–15)
  'Celesta', 'Glockenspiel', 'Music Box', 'Vibraphone',
  'Marimba', 'Xylophone', 'Tubular Bells', 'Dulcimer',
  // Organ (16–23)
  'Drawbar Organ', 'Percussive Organ', 'Rock Organ', 'Church Organ',
  'Reed Organ', 'Accordion', 'Harmonica', 'Tango Accordion',
  // Guitar (24–31)
  'Acoustic Guitar (nylon)', 'Acoustic Guitar (steel)', 'Electric Guitar (jazz)', 'Electric Guitar (clean)',
  'Electric Guitar (muted)', 'Overdriven Guitar', 'Distortion Guitar', 'Guitar Harmonics',
  // Bass (32–39)
  'Acoustic Bass', 'Electric Bass (finger)', 'Electric Bass (pick)', 'Fretless Bass',
  'Slap Bass 1', 'Slap Bass 2', 'Synth Bass 1', 'Synth Bass 2',
  // Strings (40–47)
  'Violin', 'Viola', 'Cello', 'Contrabass',
  'Tremolo Strings', 'Pizzicato Strings', 'Orchestral Harp', 'Timpani',
  // Ensemble (48–55)
  'String Ensemble 1', 'String Ensemble 2', 'Synth Strings 1', 'Synth Strings 2',
  'Choir Aahs', 'Voice Oohs', 'Synth Voice', 'Orchestra Hit',
  // Brass (56–63)
  'Trumpet', 'Trombone', 'Tuba', 'Muted Trumpet',
  'French Horn', 'Brass Section', 'Synth Brass 1', 'Synth Brass 2',
  // Reed (64–71)
  'Soprano Sax', 'Alto Sax', 'Tenor Sax', 'Baritone Sax',
  'Oboe', 'English Horn', 'Bassoon', 'Clarinet',
  // Pipe (72–79)
  'Piccolo', 'Flute', 'Recorder', 'Pan Flute',
  'Blown Bottle', 'Shakuhachi', 'Whistle', 'Ocarina',
  // Synth Lead (80–87)
  'Lead 1 (square)', 'Lead 2 (sawtooth)', 'Lead 3 (calliope)', 'Lead 4 (chiff)',
  'Lead 5 (charang)', 'Lead 6 (voice)', 'Lead 7 (fifths)', 'Lead 8 (bass + lead)',
  // Synth Pad (88–95)
  'Pad 1 (new age)', 'Pad 2 (warm)', 'Pad 3 (polysynth)', 'Pad 4 (choir)',
  'Pad 5 (bowed)', 'Pad 6 (metallic)', 'Pad 7 (halo)', 'Pad 8 (sweep)',
  // Synth Effects (96–103)
  'FX 1 (rain)', 'FX 2 (soundtrack)', 'FX 3 (crystal)', 'FX 4 (atmosphere)',
  'FX 5 (brightness)', 'FX 6 (goblins)', 'FX 7 (echoes)', 'FX 8 (sci-fi)',
  // Ethnic (104–111)
  'Sitar', 'Banjo', 'Shamisen', 'Koto',
  'Kalimba', 'Bag pipe', 'Fiddle', 'Shanai',
  // Percussive (112–119)
  'Tinkle Bell', 'Agogo', 'Steel Drums', 'Woodblock',
  'Taiko Drum', 'Melodic Tom', 'Synth Drum', 'Reverse Cymbal',
  // Sound Effects (120–127)
  'Guitar Fret Noise', 'Breath Noise', 'Seashore', 'Bird Tweet',
  'Telephone Ring', 'Helicopter', 'Applause', 'Gunshot',
];

// Full GM 128 catalog — for the "More voices" expanded list.
// 'gm-N' is the stable id; display label is the canonical GM name.
export const DRONE_FULL_GM: readonly DroneVoice[] = GM_NAMES.map((label, program) => ({
  id: `gm-${program}`,
  label,
  program,
}));

// Default — preset organ.
export const DRONE_DEFAULT_VOICE: DroneVoice = DRONE_PRESETS[0];

// Resolve a stored id back to a voice; falls back to default for unknown ids.
export function resolveDroneVoice(id: string): DroneVoice {
  for (const v of DRONE_PRESETS) if (v.id === id) return v;
  for (const v of DRONE_FULL_GM) if (v.id === id) return v;
  return DRONE_DEFAULT_VOICE;
}
