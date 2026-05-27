/**
 * drumVoices.ts — voice catalog for the v1.2 TSF-backed metronome drum picker.
 *
 * Two structural tiers (mirrors droneVoices.ts shape):
 *   - DRUM_FAMILIES — grouped + prioritized; the default picker mode (§17.R1).
 *   - DRUM_FLAT_BY_MIDI — flat ascending-MIDI list; power-user toggle mode.
 *
 * Catalog covers all 47 standard GM channel-9 notes (MIDI 35..81).
 * GM 31 ("Sticks") is omitted — GeneralUser-GS does not reliably include it
 * on channel 9 and it is outside the standard GM percussion map.
 */

// v1.2 — canonical GM channel-9 drum voice descriptor.
/** A single GM percussion instrument playable on MIDI channel 9. */
export interface DrumVoice {
  midi: number;        // GM drum note 35–81
  label: string;       // canonical GM name, e.g. "Acoustic Snare"
  shortLabel?: string; // optional cell-display, e.g. "Snare"
}

// v1.2 — a named family of related drum voices, ordered by musical priority.
/** A named grouping of GM percussion voices; voices are in musical-priority order. */
export interface DrumFamily {
  id: string;   // 'kick' | 'snare' | 'hihat' | 'cymbal' | 'tom' | 'click' | 'latin' | 'effect'
  label: string; // 'Kick & Bass', 'Snare', 'Hi-Hat', 'Cymbals', etc.
  voices: readonly DrumVoice[]; // ordered by musical priority within family
}

// ---------------------------------------------------------------------------
// Raw voice table — one object per GM percussion note.
// Defined up-front so DRUM_FAMILIES and the suggestion lookups can reference
// these objects directly (no duplicate literals, guaranteed identity parity).
// ---------------------------------------------------------------------------

// v1.2 — Kick & Bass
const KICK_BD1:    DrumVoice = { midi: 36, label: 'Bass Drum 1',       shortLabel: 'KICK'  };
const KICK_ABD:    DrumVoice = { midi: 35, label: 'Acoustic Bass Drum', shortLabel: 'BASS'  };
const KICK_STICK:  DrumVoice = { midi: 37, label: 'Side Stick',         shortLabel: 'STICK' };

// v1.2 — Snare
const SNARE_AC:    DrumVoice = { midi: 38, label: 'Acoustic Snare',    shortLabel: 'SNARE' };
const SNARE_EL:    DrumVoice = { midi: 40, label: 'Electric Snare',    shortLabel: 'E-SNR' };
const SNARE_CLAP:  DrumVoice = { midi: 39, label: 'Hand Clap',         shortLabel: 'CLAP'  };

// v1.2 — Hi-Hat
const HH_CLOSED:   DrumVoice = { midi: 42, label: 'Closed Hi-Hat',     shortLabel: 'HH-C'  };
const HH_PEDAL:    DrumVoice = { midi: 44, label: 'Pedal Hi-Hat',      shortLabel: 'HH-P'  };
const HH_OPEN:     DrumVoice = { midi: 46, label: 'Open Hi-Hat',       shortLabel: 'HH-O'  };

// v1.2 — Cymbals
const CYM_RIDE1:   DrumVoice = { midi: 51, label: 'Ride Cymbal 1',     shortLabel: 'RIDE'  };
const CYM_CRASH1:  DrumVoice = { midi: 49, label: 'Crash Cymbal 1',    shortLabel: 'CRSH'  };
const CYM_RBELL:   DrumVoice = { midi: 53, label: 'Ride Bell',         shortLabel: 'RBELL' };
const CYM_CRASH2:  DrumVoice = { midi: 57, label: 'Crash Cymbal 2',    shortLabel: 'CRS2'  };
const CYM_SPLASH:  DrumVoice = { midi: 55, label: 'Splash Cymbal',     shortLabel: 'SPLSH' };
const CYM_CHINA:   DrumVoice = { midi: 52, label: 'Chinese Cymbal',    shortLabel: 'CHINA' };
const CYM_RIDE2:   DrumVoice = { midi: 59, label: 'Ride Cymbal 2',     shortLabel: 'RDE2'  };

// v1.2 — Toms
const TOM_LOW:     DrumVoice = { midi: 41, label: 'Low Tom',           shortLabel: 'L-TOM' };
const TOM_MID:     DrumVoice = { midi: 47, label: 'Mid Tom',           shortLabel: 'M-TOM' };
const TOM_HIGH:    DrumVoice = { midi: 50, label: 'High Tom',          shortLabel: 'H-TOM' };
const TOM_HI_FLR:  DrumVoice = { midi: 43, label: 'High Floor Tom',    shortLabel: 'HFTOM' };
const TOM_LO_FLR:  DrumVoice = { midi: 45, label: 'Low Floor Tom',     shortLabel: 'LFTOM' };
const TOM_HIMID:   DrumVoice = { midi: 48, label: 'High Mid Tom',      shortLabel: 'HMTOM' };

// v1.2 — Click & Wood
const CLK_HWB:     DrumVoice = { midi: 76, label: 'High Wood Block',   shortLabel: 'CLICK' };
const CLK_LWB:     DrumVoice = { midi: 77, label: 'Low Wood Block',    shortLabel: 'L-CLK' };
const CLK_CLAVES:  DrumVoice = { midi: 75, label: 'Claves',            shortLabel: 'CLVS'  };

// v1.2 — Latin Percussion
const LAT_HBNG:    DrumVoice = { midi: 60, label: 'High Bongo',        shortLabel: 'H-BNG' };
const LAT_LBNG:    DrumVoice = { midi: 61, label: 'Low Bongo',         shortLabel: 'L-BNG' };
const LAT_MHCNG:   DrumVoice = { midi: 62, label: 'Mute High Conga',   shortLabel: 'MCNGA' };
const LAT_OHCNG:   DrumVoice = { midi: 63, label: 'Open High Conga',   shortLabel: 'OCNGA' };
const LAT_LCNG:    DrumVoice = { midi: 64, label: 'Low Conga',         shortLabel: 'L-CNG' };
const LAT_HTMBL:   DrumVoice = { midi: 65, label: 'High Timbale',      shortLabel: 'H-TMB' };
const LAT_LTMBL:   DrumVoice = { midi: 66, label: 'Low Timbale',       shortLabel: 'L-TMB' };
const LAT_COWBL:   DrumVoice = { midi: 56, label: 'Cowbell',           shortLabel: 'COWBL' };
const LAT_TAMB:    DrumVoice = { midi: 54, label: 'Tambourine',        shortLabel: 'TAMB'  };
const LAT_MARC:    DrumVoice = { midi: 70, label: 'Maracas',           shortLabel: 'MARC'  };
const LAT_CBSA:    DrumVoice = { midi: 69, label: 'Cabasa',            shortLabel: 'CBSA'  };

// v1.2 — Effects & Misc
const EFF_VSLP:    DrumVoice = { midi: 58, label: 'Vibraslap',         shortLabel: 'VSLP'  };
const EFF_SWHI:    DrumVoice = { midi: 71, label: 'Short Whistle',     shortLabel: 'S-WHI' };
const EFF_LWHI:    DrumVoice = { midi: 72, label: 'Long Whistle',      shortLabel: 'L-WHI' };
const EFF_SGUR:    DrumVoice = { midi: 73, label: 'Short Guiro',       shortLabel: 'S-GUR' };
const EFF_LGUR:    DrumVoice = { midi: 74, label: 'Long Guiro',        shortLabel: 'L-GUR' };
const EFF_HAGO:    DrumVoice = { midi: 67, label: 'High Agogo',        shortLabel: 'H-AGO' };
const EFF_LAGO:    DrumVoice = { midi: 68, label: 'Low Agogo',         shortLabel: 'L-AGO' };
const EFF_MCUI:    DrumVoice = { midi: 78, label: 'Mute Cuica',        shortLabel: 'M-CUI' };
const EFF_OCUI:    DrumVoice = { midi: 79, label: 'Open Cuica',        shortLabel: 'O-CUI' };
const EFF_MTRI:    DrumVoice = { midi: 80, label: 'Mute Triangle',     shortLabel: 'M-TRI' };
const EFF_OTRI:    DrumVoice = { midi: 81, label: 'Open Triangle',     shortLabel: 'O-TRI' };

// ---------------------------------------------------------------------------
// DRUM_FAMILIES — §17.R1 grouped + prioritized catalog.
// Default picker mode; each family's voices are in musical-priority order.
// ---------------------------------------------------------------------------

/** Grouped + prioritized drum families — the default picker mode (§17.R1). */
export const DRUM_FAMILIES: readonly DrumFamily[] = [
  {
    id: 'kick',
    label: 'Kick & Bass',
    voices: [KICK_BD1, KICK_ABD, KICK_STICK],
  },
  {
    id: 'snare',
    label: 'Snare',
    voices: [SNARE_AC, SNARE_EL, SNARE_CLAP],
  },
  {
    id: 'hihat',
    label: 'Hi-Hat',
    voices: [HH_CLOSED, HH_PEDAL, HH_OPEN],
  },
  {
    id: 'cymbal',
    label: 'Cymbals',
    voices: [CYM_RIDE1, CYM_CRASH1, CYM_RBELL, CYM_CRASH2, CYM_SPLASH, CYM_CHINA, CYM_RIDE2],
  },
  {
    id: 'tom',
    label: 'Toms',
    voices: [TOM_LOW, TOM_MID, TOM_HIGH, TOM_HI_FLR, TOM_LO_FLR, TOM_HIMID],
  },
  {
    id: 'click',
    label: 'Click & Wood',
    voices: [CLK_HWB, CLK_LWB, CLK_CLAVES],
  },
  {
    id: 'latin',
    label: 'Latin Percussion',
    voices: [
      LAT_HBNG, LAT_LBNG, LAT_MHCNG, LAT_OHCNG, LAT_LCNG,
      LAT_HTMBL, LAT_LTMBL, LAT_COWBL, LAT_TAMB, LAT_MARC, LAT_CBSA,
    ],
  },
  {
    id: 'effect',
    label: 'Effects & Misc',
    voices: [
      EFF_VSLP, EFF_SWHI, EFF_LWHI, EFF_SGUR, EFF_LGUR,
      EFF_HAGO, EFF_LAGO, EFF_MCUI, EFF_OCUI, EFF_MTRI, EFF_OTRI,
    ],
  },
] as const;

// ---------------------------------------------------------------------------
// DRUM_FLAT_BY_MIDI — power-user ascending-MIDI flat list.
// Derived from DRUM_FAMILIES so the two stay in sync; duplicates collapsed
// via Map keyed on midi number.
// ---------------------------------------------------------------------------

/** Flat ascending-MIDI list of all GM percussion notes (§17.R1 power-user toggle). */
export const DRUM_FLAT_BY_MIDI: readonly DrumVoice[] = (() => {
  const byMidi = new Map<number, DrumVoice>();
  for (const family of DRUM_FAMILIES) {
    for (const voice of family.voices) {
      if (!byMidi.has(voice.midi)) byMidi.set(voice.midi, voice);
    }
  }
  return Array.from(byMidi.values()).sort((a, b) => a.midi - b.midi);
})();

// ---------------------------------------------------------------------------
// resolveDrumByMidi — lookup by MIDI number; undefined if not in catalog.
// ---------------------------------------------------------------------------

/** Look up a DrumVoice by MIDI note number. Returns undefined if not in catalog. */
export function resolveDrumByMidi(midi: number): DrumVoice | undefined {
  for (const v of DRUM_FLAT_BY_MIDI) {
    if (v.midi === midi) return v;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Catalog-validated helpers — resolve at module init so suggestion tables
// hold DrumVoice references (not bare midi numbers).
// ---------------------------------------------------------------------------

/** Resolve at module init; throws if midi is absent — catalog integrity guard. */
function r(midi: number): DrumVoice {
  const v = resolveDrumByMidi(midi);
  if (!v) throw new Error(`drumVoices: MIDI ${midi} not in catalog`);
  return v;
}

// ---------------------------------------------------------------------------
// Defaults — §15.Q11.1, §16.U3.
// ---------------------------------------------------------------------------

/** Default kick voice for beat 1 (GM 36 Bass Drum 1). */
export const DRUM_DEFAULT_KICK:  DrumVoice = r(36);

/** Default click voice for off-beats (GM 76 High Wood Block, §15.Q11.1). */
export const DRUM_DEFAULT_CLICK: DrumVoice = r(76);

/** Default subdivision voice (GM 42 Closed Hi-Hat, §5 + §15.Q11.9). */
export const DRUM_DEFAULT_SUB:   DrumVoice = r(42);

// ---------------------------------------------------------------------------
// getSuggestionsForSlot — §17.R2 context-aware quick-pick suggestions.
// Each slot context returns 3-5 voices tuned for that rhythmic role.
// ---------------------------------------------------------------------------

/** Beat-slot context passed to the drum picker to generate relevant suggestions. */
export type BeatSlotContext = 'downbeat' | 'offbeat' | 'sub-8th' | 'sub-16th' | 'sub-triplet';

// v1.2 — suggestion table built at module init; references catalog objects.
const SUGGESTIONS: Record<BeatSlotContext, readonly DrumVoice[]> = {
  'downbeat':    [r(36), r(37), r(49), r(56), r(35)],
  'offbeat':     [r(76), r(42), r(37), r(56), r(77)],
  'sub-8th':     [r(42), r(44), r(54), r(70)],
  'sub-16th':    [r(42), r(44), r(70), r(69)],
  'sub-triplet': [r(42), r(46), r(44), r(54)],
};

/**
 * Returns 3–5 context-appropriate quick-pick voices for the top of the drum
 * picker when opened from the given beat slot (§17.R2).
 */
export function getSuggestionsForSlot(ctx: BeatSlotContext): readonly DrumVoice[] {
  return SUGGESTIONS[ctx];
}
