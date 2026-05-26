/**
 * Instrument catalog: families, transpositions, ranges, and display names.
 *
 * Data ported verbatim from sax_instruments.py (desktop reference).
 * Transposition convention: transp = sounding_midi - fingered_midi.
 * Ranges are fingered MIDI (lo, hi) inclusive, sourced from MuseScore
 * instruments.xml (aPitchRange / amateur range), converted sounding → fingered.
 *
 * No runtime overrides, no custom instruments, no persistence — those are
 * handled separately in chunk 4 (Android prefs).
 */

export interface InstrumentDef {
  key: string;
  transp: number;       // sounding_midi - fingered_midi; negative = sounds below written
  nameDe: string;
  nameEn: string;
  family: string;       // family key, e.g. 'saxophone', 'clarinet', 'flute', etc.
}

export interface FamilyDef {
  key: string;
  nameDe: string;
  nameEn: string;
  instruments: string[];  // instrument keys in display order
}

// ---------------------------------------------------------------------------
// Raw catalog — order preserved from sax_instruments.py _FAMILIES
// ---------------------------------------------------------------------------

export const INSTRUMENTS: InstrumentDef[] = [
  // Saxophone
  { key: 'eb_sopranino',         transp:  +3, nameDe: 'Eb-Sax · Sopranino',       nameEn: 'Eb Sax · Sopranino',       family: 'saxophone' },
  { key: 'bb_soprano',           transp:  -2, nameDe: 'Bb-Sax · Sopran',           nameEn: 'Bb Sax · Soprano',         family: 'saxophone' },
  { key: 'eb_alto',              transp:  -9, nameDe: 'Eb-Sax · Alt',              nameEn: 'Eb Sax · Alto',            family: 'saxophone' },
  { key: 'bb_tenor',             transp: -14, nameDe: 'Bb-Sax · Tenor',            nameEn: 'Bb Sax · Tenor',           family: 'saxophone' },
  { key: 'eb_bari',              transp: -21, nameDe: 'Eb-Sax · Bariton',          nameEn: 'Eb Sax · Baritone',        family: 'saxophone' },
  { key: 'bb_bass',              transp: -26, nameDe: 'Bb-Sax · Bass',             nameEn: 'Bb Sax · Bass',            family: 'saxophone' },
  { key: 'eb_contrabass',        transp: -33, nameDe: 'Eb-Sax · Kontrabass',       nameEn: 'Eb Sax · Contrabass',      family: 'saxophone' },
  // Clarinet
  { key: 'clar_eb',              transp:  +3, nameDe: 'Eb-Klarinette',             nameEn: 'Eb Clarinet',              family: 'clarinet' },
  { key: 'clar_d',               transp:  +2, nameDe: 'D-Klarinette',              nameEn: 'D Clarinet',               family: 'clarinet' },
  { key: 'clar_c',               transp:   0, nameDe: 'C-Klarinette',              nameEn: 'C Clarinet',               family: 'clarinet' },
  { key: 'clar_bb',              transp:  -2, nameDe: 'Bb-Klarinette',             nameEn: 'Bb Clarinet',              family: 'clarinet' },
  { key: 'clar_a',               transp:  -3, nameDe: 'A-Klarinette',              nameEn: 'A Clarinet',               family: 'clarinet' },
  { key: 'clar_basset_f',        transp:  -7, nameDe: 'Bassetthorn (F)',            nameEn: 'Basset Horn (F)',           family: 'clarinet' },
  { key: 'clar_alto_eb',         transp:  -9, nameDe: 'Eb-Altklarinette',          nameEn: 'Eb Alto Clarinet',         family: 'clarinet' },
  { key: 'clar_bass_bb',         transp: -14, nameDe: 'Bb-Bassklarinette',         nameEn: 'Bb Bass Clarinet',         family: 'clarinet' },
  { key: 'clar_contraalto_eb',   transp: -21, nameDe: 'Eb-Kontra-Altklarinette',   nameEn: 'Eb Contra-Alto Clarinet',  family: 'clarinet' },
  { key: 'clar_contrabass_bb',   transp: -26, nameDe: 'Bb-Kontrabassklarinette',   nameEn: 'Bb Contrabass Clarinet',   family: 'clarinet' },
  // Flute
  { key: 'flute_piccolo',        transp: +12, nameDe: 'Piccolo (C)',               nameEn: 'Piccolo (C)',              family: 'flute' },
  { key: 'flute_c',              transp:   0, nameDe: 'Querflöte (C)',             nameEn: 'Concert Flute (C)',        family: 'flute' },
  { key: 'flute_alto_g',         transp:  -5, nameDe: 'Altflöte (G)',              nameEn: 'Alto Flute (G)',           family: 'flute' },
  { key: 'flute_bass_c',         transp: -12, nameDe: 'Bassflöte (C)',             nameEn: 'Bass Flute (C)',           family: 'flute' },
  // Trumpet
  { key: 'trp_piccolo_bb',       transp: +10, nameDe: 'Piccolo-Trompete Bb',       nameEn: 'Piccolo Trumpet Bb',       family: 'trumpet' },
  { key: 'trp_piccolo_a',        transp:  +9, nameDe: 'Piccolo-Trompete A',        nameEn: 'Piccolo Trumpet A',        family: 'trumpet' },
  { key: 'trp_f',                transp:  +5, nameDe: 'F-Trompete',               nameEn: 'F Trumpet',                family: 'trumpet' },
  { key: 'trp_e',                transp:  +4, nameDe: 'E-Trompete',               nameEn: 'E Trumpet',                family: 'trumpet' },
  { key: 'trp_eb',               transp:  +3, nameDe: 'Eb-Trompete',              nameEn: 'Eb Trumpet',               family: 'trumpet' },
  { key: 'trp_d',                transp:  +2, nameDe: 'D-Trompete',               nameEn: 'D Trumpet',                family: 'trumpet' },
  { key: 'trp_c',                transp:   0, nameDe: 'C-Trompete',               nameEn: 'C Trumpet',                family: 'trumpet' },
  { key: 'trp_bb',               transp:  -2, nameDe: 'Bb-Trompete',              nameEn: 'Bb Trumpet',               family: 'trumpet' },
  { key: 'trp_a',                transp:  -3, nameDe: 'A-Trompete',               nameEn: 'A Trumpet',                family: 'trumpet' },
  { key: 'trp_bass_bb',          transp: -14, nameDe: 'Bb-Basstrompete',          nameEn: 'Bb Bass Trumpet',          family: 'trumpet' },
  { key: 'cornet_bb',            transp:  -2, nameDe: 'Bb-Kornett',               nameEn: 'Bb Cornet',                family: 'trumpet' },
  { key: 'flugel_bb',            transp:  -2, nameDe: 'Bb-Flügelhorn',            nameEn: 'Bb Flugelhorn',            family: 'trumpet' },
  // Horn
  { key: 'horn_f',               transp:  -7, nameDe: 'F-Horn',                   nameEn: 'F Horn',                   family: 'horn' },
  { key: 'horn_bb',              transp:  -2, nameDe: 'Bb-Horn',                  nameEn: 'Bb Horn',                  family: 'horn' },
  { key: 'horn_eb_alto',         transp:  +3, nameDe: 'Eb-Althorn',               nameEn: 'Eb Alto Horn',             family: 'horn' },
  { key: 'mellophone_f',         transp:  -7, nameDe: 'Mellophon F',              nameEn: 'Mellophone F',             family: 'horn' },
  // Trombone
  { key: 'tbn_alto_eb',          transp:   0, nameDe: 'Altposaune Eb',            nameEn: 'Alto Trombone Eb',         family: 'trombone' },
  { key: 'tbn_tenor',            transp:   0, nameDe: 'Tenorposaune',             nameEn: 'Tenor Trombone',           family: 'trombone' },
  { key: 'tbn_bass',             transp:   0, nameDe: 'Bassposaune',              nameEn: 'Bass Trombone',            family: 'trombone' },
  { key: 'tbn_contrabass',       transp:   0, nameDe: 'Kontrabassposaune',        nameEn: 'Contrabass Trombone',      family: 'trombone' },
  // Low brass
  { key: 'euph_bc',              transp:   0, nameDe: 'Euphonium (Bassschl.)',     nameEn: 'Euphonium (Bass Clef)',     family: 'low_brass' },
  { key: 'euph_tc',              transp: -14, nameDe: 'Euphonium (Violinschl.)',   nameEn: 'Euphonium (Treble Clef)',   family: 'low_brass' },
  { key: 'baritone_bc',          transp:   0, nameDe: 'Baritonhorn (Bassschl.)',   nameEn: 'Baritone Horn (BC)',        family: 'low_brass' },
  { key: 'baritone_tc',          transp: -14, nameDe: 'Baritonhorn (Violinschl.)', nameEn: 'Baritone Horn (TC)',        family: 'low_brass' },
  { key: 'tuba_f',               transp:   0, nameDe: 'F-Tuba',                   nameEn: 'F Tuba',                   family: 'low_brass' },
  { key: 'tuba_eb',              transp:   0, nameDe: 'Eb-Tuba',                  nameEn: 'Eb Tuba',                  family: 'low_brass' },
  { key: 'tuba_cc',              transp:   0, nameDe: 'CC-Tuba',                  nameEn: 'CC Tuba',                  family: 'low_brass' },
  { key: 'tuba_bbb',             transp:   0, nameDe: 'BBb-Tuba',                 nameEn: 'BBb Tuba',                 family: 'low_brass' },
  { key: 'sousaphone_bbb',       transp:   0, nameDe: 'Sousaphon BBb',            nameEn: 'Sousaphone BBb',           family: 'low_brass' },
  // Double reed
  { key: 'oboe',                 transp:   0, nameDe: 'Oboe',                     nameEn: 'Oboe',                     family: 'double_reed' },
  { key: 'oboe_damore',          transp:  -3, nameDe: 'Oboe d’amore',        nameEn: 'Oboe d’amore',        family: 'double_reed' },
  { key: 'english_horn',         transp:  -7, nameDe: 'Englischhorn (F)',         nameEn: 'English Horn (F)',         family: 'double_reed' },
  { key: 'bassoon',              transp:   0, nameDe: 'Fagott',                   nameEn: 'Bassoon',                  family: 'double_reed' },
  { key: 'contrabassoon',        transp: -12, nameDe: 'Kontrafagott',             nameEn: 'Contrabassoon',            family: 'double_reed' },
  // Recorder
  { key: 'rec_sopranino_f',      transp:  +5, nameDe: 'Sopranino-Blockflöte (F)', nameEn: 'Sopranino Recorder (F)',   family: 'recorder' },
  { key: 'rec_soprano_c',        transp: +12, nameDe: 'Sopran-Blockflöte (C)',    nameEn: 'Soprano Recorder (C)',     family: 'recorder' },
  { key: 'rec_alto_f',           transp:   0, nameDe: 'Alt-Blockflöte (F)',       nameEn: 'Alto Recorder (F)',        family: 'recorder' },
  { key: 'rec_tenor_c',          transp:   0, nameDe: 'Tenor-Blockflöte (C)',     nameEn: 'Tenor Recorder (C)',       family: 'recorder' },
  { key: 'rec_bass_f',           transp:   0, nameDe: 'Bass-Blockflöte (F)',      nameEn: 'Bass Recorder (F)',        family: 'recorder' },
  // Strings
  { key: 'violin',               transp:   0, nameDe: 'Violine',                  nameEn: 'Violin',                   family: 'strings' },
  { key: 'viola',                transp:   0, nameDe: 'Viola',                    nameEn: 'Viola',                    family: 'strings' },
  { key: 'cello',                transp:   0, nameDe: 'Violoncello',              nameEn: 'Cello',                    family: 'strings' },
  { key: 'double_bass',          transp:   0, nameDe: 'Kontrabass',               nameEn: 'Double Bass',              family: 'strings' },
  { key: 'mandolin',             transp:   0, nameDe: 'Mandoline',                nameEn: 'Mandolin',                 family: 'strings' },
  // Plucked
  { key: 'guitar',               transp:   0, nameDe: 'Gitarre',                  nameEn: 'Guitar',                   family: 'plucked' },
  { key: 'bass_guitar',          transp:   0, nameDe: 'Bassgitarre',              nameEn: 'Bass Guitar',              family: 'plucked' },
  { key: 'ukulele',              transp:   0, nameDe: 'Ukulele',                  nameEn: 'Ukulele',                  family: 'plucked' },
  { key: 'banjo',                transp:   0, nameDe: 'Banjo',                    nameEn: 'Banjo',                    family: 'plucked' },
  { key: 'harp',                 transp:   0, nameDe: 'Harfe',                    nameEn: 'Harp',                     family: 'plucked' },
  // Voice / Concert
  { key: 'voice',                transp:   0, nameDe: 'Stimme',                   nameEn: 'Voice',                    family: 'voice_other' },
  { key: 'c',                    transp:   0, nameDe: 'C-Instrument',             nameEn: 'C Instrument',             family: 'voice_other' },
  { key: 'piano',                transp:   0, nameDe: 'Klavier',                  nameEn: 'Piano',                    family: 'voice_other' },
];

// ---------------------------------------------------------------------------
// Families — order and groupings preserved from sax_instruments.py _FAMILIES
// ---------------------------------------------------------------------------

export const FAMILIES: FamilyDef[] = [
  { key: 'saxophone',   nameDe: 'Saxophon',              nameEn: 'Saxophone',    instruments: ['eb_sopranino', 'bb_soprano', 'eb_alto', 'bb_tenor', 'eb_bari', 'bb_bass', 'eb_contrabass'] },
  { key: 'clarinet',    nameDe: 'Klarinette',            nameEn: 'Clarinet',     instruments: ['clar_eb', 'clar_d', 'clar_c', 'clar_bb', 'clar_a', 'clar_basset_f', 'clar_alto_eb', 'clar_bass_bb', 'clar_contraalto_eb', 'clar_contrabass_bb'] },
  { key: 'flute',       nameDe: 'Flöte',                 nameEn: 'Flute',        instruments: ['flute_piccolo', 'flute_c', 'flute_alto_g', 'flute_bass_c'] },
  { key: 'trumpet',     nameDe: 'Trompete',              nameEn: 'Trumpet',      instruments: ['trp_piccolo_bb', 'trp_piccolo_a', 'trp_f', 'trp_e', 'trp_eb', 'trp_d', 'trp_c', 'trp_bb', 'trp_a', 'trp_bass_bb', 'cornet_bb', 'flugel_bb'] },
  { key: 'horn',        nameDe: 'Horn',                  nameEn: 'Horn',         instruments: ['horn_f', 'horn_bb', 'horn_eb_alto', 'mellophone_f'] },
  { key: 'trombone',    nameDe: 'Posaune',               nameEn: 'Trombone',     instruments: ['tbn_alto_eb', 'tbn_tenor', 'tbn_bass', 'tbn_contrabass'] },
  { key: 'low_brass',   nameDe: 'Tiefes Blech',          nameEn: 'Low Brass',    instruments: ['euph_bc', 'euph_tc', 'baritone_bc', 'baritone_tc', 'tuba_f', 'tuba_eb', 'tuba_cc', 'tuba_bbb', 'sousaphone_bbb'] },
  { key: 'double_reed', nameDe: 'Doppelrohrblatt',       nameEn: 'Double Reed',  instruments: ['oboe', 'oboe_damore', 'english_horn', 'bassoon', 'contrabassoon'] },
  { key: 'recorder',    nameDe: 'Blockflöte',            nameEn: 'Recorder',     instruments: ['rec_sopranino_f', 'rec_soprano_c', 'rec_alto_f', 'rec_tenor_c', 'rec_bass_f'] },
  { key: 'strings',     nameDe: 'Streicher',             nameEn: 'Strings',      instruments: ['violin', 'viola', 'cello', 'double_bass', 'mandolin'] },
  { key: 'plucked',     nameDe: 'Zupfinstrumente',       nameEn: 'Plucked',      instruments: ['guitar', 'bass_guitar', 'ukulele', 'banjo', 'harp'] },
  { key: 'voice_other', nameDe: 'Stimme / Konzertstimmung', nameEn: 'Voice / Concert', instruments: ['voice', 'c', 'piano'] },
];

// ---------------------------------------------------------------------------
// Flat lookup maps — derived from INSTRUMENTS so there is a single source
// of truth; no manual sync required.
// ---------------------------------------------------------------------------

export const transpMap: Record<string, number> = Object.fromEntries(
  INSTRUMENTS.map((i) => [i.key, i.transp]),
);

// Fingered MIDI ranges (lo, hi) inclusive.
// Source: MuseScore instruments.xml aPitchRange, converted sounding → fingered.
// Real-player overrides (saxes at low A, contras at low C) are layered on top.
// Regeneration script: tools/musescore/sync_ranges.py in desktop repo.
export const rangeMap: Record<string, [number, number]> = {
  // Saxophones — fingered low A (57) to altissimo C7 (96)
  eb_sopranino:           [  57,  96 ],
  bb_soprano:             [  57,  96 ],
  eb_alto:                [  57,  96 ],
  bb_tenor:               [  57,  96 ],
  eb_bari:                [  57,  96 ],
  bb_bass:                [  57,  96 ],
  eb_contrabass:          [  57,  96 ],
  // Clarinets
  clar_eb:                [  52,  96 ],
  clar_d:                 [  52,  96 ],
  clar_c:                 [  52,  96 ],
  clar_bb:                [  52,  96 ],
  clar_a:                 [  52,  96 ],
  clar_basset_f:          [  48,  96 ],
  clar_alto_eb:           [  52,  91 ],
  clar_bass_bb:           [  48,  96 ],
  clar_contraalto_eb:     [  48,  91 ],
  clar_contrabass_bb:     [  48,  91 ],
  // Flutes
  flute_piccolo:          [  62,  93 ],
  flute_c:                [  60,  93 ],
  flute_alto_g:           [  60,  93 ],
  flute_bass_c:           [  60,  89 ],
  // Trumpets
  trp_piccolo_bb:         [  49,  76 ],
  trp_piccolo_a:          [  49,  76 ],
  trp_f:                  [  60,  77 ],
  trp_e:                  [  54,  81 ],
  trp_eb:                 [  54,  81 ],
  trp_d:                  [  54,  81 ],
  trp_c:                  [  54,  82 ],
  trp_bb:                 [  54,  82 ],
  trp_a:                  [  54,  82 ],
  trp_bass_bb:            [  54,  81 ],
  cornet_bb:              [  54,  81 ],
  flugel_bb:              [  54,  81 ],
  // Horns
  horn_f:                 [  48,  76 ],
  horn_bb:                [  46,  79 ],
  horn_eb_alto:           [  54,  81 ],
  mellophone_f:           [  54,  79 ],
  // Trombones
  tbn_alto_eb:            [  45,  74 ],
  tbn_tenor:              [  40,  71 ],
  tbn_bass:               [  32,  65 ],
  tbn_contrabass:         [  28,  62 ],
  // Low brass
  euph_bc:                [  40,  70 ],
  euph_tc:                [  54,  84 ],
  baritone_bc:            [  43,  64 ],
  baritone_tc:            [  54,  81 ],
  tuba_f:                 [  26,  64 ],
  tuba_eb:                [  26,  64 ],
  tuba_cc:                [  26,  60 ],
  tuba_bbb:               [  28,  58 ],
  sousaphone_bbb:         [  44,  74 ],
  // Double reeds
  oboe:                   [  58,  87 ],
  oboe_damore:            [  59,  87 ],
  english_horn:           [  59,  88 ],
  bassoon:                [  34,  69 ],
  contrabassoon:          [  34,  69 ],
  // Recorders
  rec_sopranino_f:        [  77, 100 ],
  rec_soprano_c:          [  72,  93 ],
  rec_alto_f:             [  65,  88 ],
  rec_tenor_c:            [  60,  81 ],
  rec_bass_f:             [  53,  74 ],
  // Strings
  violin:                 [  55,  88 ],
  viola:                  [  48,  79 ],
  cello:                  [  36,  67 ],
  double_bass:            [  40,  74 ],
  mandolin:               [  55,  85 ],
  // Plucked
  guitar:                 [  40,  83 ],
  bass_guitar:            [  40,  77 ],
  ukulele:                [  60,  81 ],
  banjo:                  [  48,  87 ],
  harp:                   [  23, 104 ],
  // Concert / generic
  voice:                  [  41,  79 ],
  c:                      [  48,  79 ],
  piano:                  [  21, 108 ],
};

// ---------------------------------------------------------------------------
// Convenience lookups
// ---------------------------------------------------------------------------

const _instrumentIndex: Map<string, InstrumentDef> = new Map(
  INSTRUMENTS.map((i) => [i.key, i]),
);

const _familyIndex: Map<string, FamilyDef> = new Map(
  FAMILIES.map((f) => [f.key, f]),
);

export function getInstrument(key: string): InstrumentDef | undefined {
  return _instrumentIndex.get(key);
}

export function getFamily(key: string): FamilyDef | undefined {
  return _familyIndex.get(key);
}
