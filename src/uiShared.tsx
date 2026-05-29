/**
 * uiShared.tsx — shared style factory and layout constants for the BELLCURVE
 * app. Extracted from App.tsx during the four-tab refactor so each screen
 * (TUNER / METRO / DECK / SETUP) can use the same StyleSheet without a
 * circular import via the App module.
 *
 * `makeStyles(palette)` returns a StyleSheet keyed by the same property names
 * components have always used; nothing inside the keys changed during the
 * extraction. New screens added new keys at the bottom (look for the
 * "v0.9.0 — new tab system" banner).
 */
import { StyleSheet } from 'react-native';
import { H } from './theme';
import type { ThemePalette } from './theme';

// ---------------------------------------------------------------------------
// Layout constants — used by Pressable timings and the PeakSlideToggle knob
// arithmetic. Kept here so screens can compute KnobLeft/Travel without
// duplicating the magic numbers.
// ---------------------------------------------------------------------------

/**
 * Pressables inside scrollable sheets (settings + instrument picker) use this
 * delay so a drag motion is detected by the parent ScrollView before the
 * Pressable claims the touch responder.
 */
export const DRAG_FRIENDLY_PRESS_DELAY_MS = 120;

export const PEAK_TRACK_WIDTH = 240;
export const PEAK_TRACK_HEIGHT = 56;
export const PEAK_KNOB_WIDTH = 116;
export const PEAK_PAD = 4;
export const PEAK_TRAVEL = PEAK_TRACK_WIDTH - PEAK_KNOB_WIDTH - PEAK_PAD * 2;

// dBFS scale endpoints for tick-position math (must match engine's 'low' map).
export const METER_FLOOR_DB = -60;
export const METER_CEIL_DB = 0;

export const REF_HZ_MIN = 430;
export const REF_HZ_MAX = 450;
export const REF_HZ_DEFAULT = 440;

export const CENT_TICK_COUNT = 21; // -50, -45, …, 0, …, +45, +50
export const CENT_RANGE = 50;

export const PEAK_DECAY_PER_SEC = 0.6;
export const IDLE_GLOW = 0.02;
export const LAND_RAIL_W = 72;

/**
 * Tablet dual-pane eligibility. True only on a TABLET in LANDSCAPE — i.e. the
 * canvas is landscape (width > height) AND its smallest dimension is at least
 * 600dp (Android's smallestWidth>=600dp tablet bucket). `useWindowDimensions`
 * returns dp, so phones (smallest dim < 600dp, incl. pixel_7 ≈411dp tall in
 * landscape) return false and keep the single-screen split shipped earlier.
 */
export function isDualPaneEligible(width: number, height: number): boolean {
  return width > height && Math.min(width, height) >= 600;
}

// ---------------------------------------------------------------------------
// Style factory
// ---------------------------------------------------------------------------

export function makeStyles(C: ThemePalette) {
  return StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg, padding: 16 },
  // Tab-host root: identical bg, but no padding so the bottom TabBar can
  // anchor flush to the bottom edge. The screen body owns its own padding.
  rootTabbed: { flex: 1, backgroundColor: C.bg },
  // #69 landscape — root becomes a row so the persistent chrome sits in a
  // LEFT rail and the navigator fills the remainder at full height.
  rootTabbedLand: { flexDirection: 'row' },
  faceplate: {
    flex: 1,
    backgroundColor: C.face,
    borderColor: C.edge,
    borderWidth: 1,
    borderRadius: 4,
    paddingHorizontal: 28,
    paddingVertical: 18,
  },
  // Variant used by tabbed screens — no outer border, no per-screen padding,
  // letting the TabBar sit visually attached. The screen body adds 16dp of
  // horizontal padding inside.
  faceplateTabbed: {
    flex: 1,
    backgroundColor: C.face,
    paddingHorizontal: 24,
    paddingVertical: 14,
  },
  // Header zone used in the navigator-based layout (v0.9.3+). Sits ABOVE
  // the bottom-tab navigator and persists across tabs. Matches the
  // horizontal padding of `faceplateTabbed`, no flex (size hugs content), no
  // bottom padding because the navigator's scene padding picks up there.
  faceplateHeader: {
    backgroundColor: C.face,
    paddingHorizontal: 24,
    paddingTop: 14,
  },
  // #69 landscape rail — fixed-width LEFT column (LAND_RAIL_W = 72). Holds the
  // vertical BELLCURVE wordmark + status dot + compact badge ONLY; the A= /
  // PAGE-CONCERT / TABLE-PIPES chrome relocates into each screen's control
  // column (LandscapeChromeControls). The navigator (flex:1) takes the rest;
  // no flex → width is authoritative; right border mirrors the top band's.
  faceplateRail: {
    width: LAND_RAIL_W,
    borderRightColor: C.edge,
    borderRightWidth: 1,
    paddingHorizontal: 12,
  },

  // Top bar — column flex so row1 and row2 stack vertically. Tight padding
  // per the spec ("tiny pad").
  topBar: {
    flexDirection: 'column',
    borderBottomColor: C.edgeSoft,
    borderBottomWidth: 1,
    paddingBottom: 6,
  },
  topBarCompact: { paddingBottom: 4 },
  topLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    flexShrink: 1,
    flexWrap: 'wrap',
  },
  topRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    flexShrink: 0,
  },
  // BELLCURVE wordmark — sits at the top of the persistent header. The
  // padding here is purely visual breathing room around the glyphs; we used
  // to lean heavier (paddingTop:20 / paddingBottom:18) but that ate 22dp
  // from the body budget on every tab. The current values give the wordmark
  // air without crowding the controls below.
  brand: {
    color: C.ink,
    fontSize: 28,
    letterSpacing: 8,
    fontWeight: '800',
    paddingTop: 8,
    paddingBottom: 6,
    paddingHorizontal: 4,
    textAlign: 'left',
  },
  brandCompact: { color: C.ink, fontSize: 11, letterSpacing: 4, fontWeight: '600' },
  brandVersion: { color: C.inkDim, fontSize: 10, letterSpacing: 2, fontVariant: ['tabular-nums'] },
  instrumentBadge: { color: C.accent, fontSize: 13, letterSpacing: 2, fontWeight: '700' },
  badgePressable: {
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderColor: C.edge,
    borderWidth: 1,
    borderRadius: 4,
    minHeight: H.touchTarget,
    justifyContent: 'center',
    flexShrink: 1,
  },
  badgePressablePressed: { backgroundColor: C.edge },
  hornNameCaption: {
    color: C.inkMid,
    fontSize: 10,
    letterSpacing: 1,
    marginTop: 2,
    maxWidth: 220,
  },

  displayToggle: { flexDirection: 'row', gap: 2 },
  displayPill: {
    minWidth: 56,
    height: H.pillHeight,
    paddingHorizontal: 8,
    borderColor: C.edge,
    borderWidth: 1,
    borderRadius: 4,
    alignItems: 'center',
    justifyContent: 'center',
  },
  displayPillActive: { backgroundColor: C.accent, borderColor: C.accent },
  displayPillText: { color: C.inkMid, fontSize: 11, letterSpacing: 2, fontWeight: '700' },
  displayPillTextActive: { color: C.onAccent },

  refContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 6,
    minHeight: H.touchTarget,
    borderColor: C.edge,
    borderWidth: 1,
    borderRadius: 4,
  },
  refLabel: { color: C.inkDim, fontSize: 11, letterSpacing: 3 },
  refValue: { color: C.ink, fontSize: 14, letterSpacing: 2, fontVariant: ['tabular-nums'], fontWeight: '700' },
  refStepper: { flexDirection: 'row', gap: 6, alignItems: 'center' },
  stepBtn: {
    width: H.touchTarget,
    height: H.touchTarget,
    borderColor: 'transparent',
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepBtnPressed: { backgroundColor: C.edge },
  stepBtnText: { color: C.accent, fontSize: 16, lineHeight: 18, fontWeight: '700' },
  statusPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderColor: C.edge,
    borderWidth: 1,
    borderRadius: 2,
  },
  statusDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: C.accent },
  statusText: { color: C.inkMid, fontSize: 10, letterSpacing: 3 },
  streamErrorMicro: {
    color: C.sharp,
    fontSize: 9,
    letterSpacing: 1,
    marginTop: 2,
    maxWidth: 200,
  },

  carSwitch: {
    marginTop: 8,
    minHeight: 48,
    paddingHorizontal: 14,
    paddingVertical: 10,
    backgroundColor: C.warnBg,
    borderColor: C.accent,
    borderWidth: 1,
    borderRadius: 3,
  },
  carSwitchActive: { backgroundColor: C.successTint, borderColor: C.inTune },
  carSwitchPending: { borderColor: C.inkDim, backgroundColor: C.bg },
  carSwitchPressed: { opacity: 0.75 },
  carSwitchInner: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  carSwitchIndicator: { width: 10, height: 10, borderRadius: 5, backgroundColor: C.accent, opacity: 0.6 },
  carSwitchIndicatorOn: { backgroundColor: C.inTune, opacity: 1 },
  carSwitchLabel: { flex: 1, color: C.accent, fontSize: 11, letterSpacing: 2.5, fontWeight: '700' },
  carSwitchLabelOn: { color: C.inTune },
  carSwitchLabelPending: { color: C.inkDim },
  carSwitchState: { color: C.accent, fontSize: 13, letterSpacing: 2, fontWeight: '700', minWidth: 28, textAlign: 'right' },
  carSwitchStateOn: { color: C.inTune },

  silenceBanner: {
    marginTop: 8,
    paddingHorizontal: 14,
    paddingVertical: 8,
    backgroundColor: C.warnBg,
    borderColor: C.warnBorder,
    borderWidth: 1,
    borderRadius: 2,
  },
  silenceBannerText: { color: C.accent, fontSize: 11, lineHeight: 16, letterSpacing: 0.5 },
  silenceBannerBold: { fontWeight: '700' },

  center: { flex: 1, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 40 },
  // v0.9.9 — dropped `alignItems: 'center'`: cross-axis centering was shrinking
  // CentArc / LedRow children to their intrinsic NoteReadout glyph width
  // (narrow on "—", wider on "B♭ 5"). Each child now owns its own width.
  // #70 — was `justifyContent:'center'` with no clip: the un-shrinkable ~324dp
  // CentArc+NoteReadout stack overflowed BOTH ways (over the toggle above + the
  // readout/CTA below) on any canvas shorter in dp than the Pixel 9 Pro design
  // target (pixel_7 914dp vs 952dp — higher density = fewer dp; also tablet +
  // landscape). Top-anchor so the arc's Y depends only on the fixed toggle
  // above (it can no longer move when a note appears/disappears — this
  // STRENGTHENS the wave-5 stability), flexShrink + clip so worst-case it trims
  // bottom detail instead of drawing over the toggle.
  centerPortrait: { flex: 1, flexShrink: 1, justifyContent: 'flex-start', paddingHorizontal: 20, paddingTop: 8, overflow: 'hidden' },

  arc: { maxWidth: 720, alignSelf: 'center' },
  arcScaleRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6 },
  arcEnd: { color: C.inkDim, fontSize: 11, letterSpacing: 2, fontVariant: ['tabular-nums'] },
  arcCenterLabel: { color: C.inkMid, fontSize: 11, letterSpacing: 2, fontVariant: ['tabular-nums'] },
  // v0.9.8 CentArc rebuild — zones MOVED BEHIND the ticks (was a 2dp
  // hairline underneath at 35 % opacity, essentially invisible). The
  // track is now 56dp tall, zones fill it as a backdrop at 0.45–0.55
  // opacity, and the tick marks render on top in high-contrast ink
  // colors. The needle is widened to 4dp + tagged with a colored tip so
  // it can no longer be confused with an active tick.
  arcTrack: { height: 56, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end', position: 'relative', borderRadius: 2, overflow: 'hidden' },
  arcZonesBackdrop: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, flexDirection: 'row' },
  arcTick: { width: 1, height: 12, backgroundColor: C.inkMid, opacity: 0.7, zIndex: 1 },
  // Sub-major: tick mark at ±25 — the labels reference these positions and
  // they need visible weight beneath the label text.
  arcTickSubMajor: { width: 1.5, height: 20, backgroundColor: C.ink, opacity: 0.85 },
  arcTickMajor: { width: 2, height: 28, backgroundColor: C.ink },
  arcTickCenter: { width: 3, height: 36, backgroundColor: C.ink },
  arcTickActive: { opacity: 1 },
  // #67 — NO `elevation`/`shadow*` here. On Android an elevated view draws on
  // its own surface and is NOT clipped by the parent `arcTrack`'s
  // `overflow:'hidden'`; the amber shadow (and, at the spring's underdamped
  // overshoot, the needle body) bled OUTSIDE the track — over the scale labels
  // above and the note/cents readout below — and appeared to "float" as the
  // needle swept. Plain zIndex keeps it above the ticks without leaving the
  // clip. The 4dp width + accent color already distinguish it from a tick.
  arcNeedle: { position: 'absolute', top: 0, bottom: 0, width: 4, marginLeft: -2, backgroundColor: C.accent, borderRadius: 2, zIndex: 10 },
  arcZones: { flexDirection: 'row', marginTop: 4, height: 2 },
  arcZone: { height: '100%' },
  arcZoneFlat: { flex: 35, backgroundColor: C.flat, opacity: 0.45 },
  arcZoneInTune: { flex: 30, backgroundColor: C.inTune, opacity: 0.55 },
  arcZoneSharp: { flex: 35, backgroundColor: C.sharp, opacity: 0.45 },

  noteBlock: { alignItems: 'center', marginTop: 12 },
  noteRow: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'center' },
  noteSlot: { flexDirection: 'row', alignItems: 'flex-start' },
  note: { color: C.ink, fontWeight: '300', letterSpacing: -2, fontVariant: ['tabular-nums'] },
  noteDim: { color: C.inkDim },
  accidental: { color: C.inkMid, fontWeight: '300' },
  octave: { color: C.inkDim, fontVariant: ['tabular-nums'], marginLeft: 10, letterSpacing: 1 },
  hzRow: { flexDirection: 'row', alignItems: 'baseline', gap: 8, marginTop: -8 },
  hzValue: { color: C.inkMid, fontSize: 22, letterSpacing: 4, fontVariant: ['tabular-nums'] },
  hzUnit: { color: C.inkDim, fontSize: 12, letterSpacing: 3 },
  centValueRow: { flexDirection: 'row', alignItems: 'baseline', gap: 10, marginTop: 10 },
  centValueLabel: { color: C.inkDim, fontSize: 10, letterSpacing: 3 },
  centValue: { color: C.inkMid, fontSize: 14, letterSpacing: 2, fontVariant: ['tabular-nums'] },
  dimText: { color: C.inkVeryDim },

  centsBig: { fontSize: 32, fontWeight: '700', letterSpacing: 1, fontVariant: ['tabular-nums'], marginTop: 6, textAlign: 'center' },
  centsBigUnit: { fontSize: 18, fontWeight: '400', color: C.inkDim, letterSpacing: 1 },

  // alignSelf:'center' replaces what `centerPortrait`'s alignItems used to do.
  emptyHint: { marginTop: 18, paddingVertical: 12, paddingHorizontal: 24, alignItems: 'center', alignSelf: 'center' },
  emptyHintText: { color: C.inkDim, fontSize: 14, letterSpacing: 2, textAlign: 'center' },

  logCtaRow: { flexDirection: 'row', gap: 10, paddingVertical: 8, paddingHorizontal: 8, alignItems: 'stretch' },
  logCtaBar: {
    flex: 1,
    minHeight: 56,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: C.accent,
    backgroundColor: C.face,
    alignItems: 'center',
    justifyContent: 'center',
  },
  logCtaBarFlashOk: { backgroundColor: C.accentTint, borderColor: C.accent },
  logCtaBarFlashBad: { backgroundColor: C.dangerTint, borderColor: C.sharp },
  logCtaBarDisabled: { opacity: 0.4, borderColor: C.edge },
  logCtaBarPressed: { opacity: 0.7 },
  logCtaText: { color: C.accent, fontSize: 14, letterSpacing: 3, fontWeight: '700', fontVariant: ['tabular-nums'], textAlign: 'center' },
  logCtaTextFlash: { color: C.ink },
  logCtaTextDisabled: { color: C.inkDim },
  undoBar: {
    minWidth: 96,
    paddingHorizontal: 12,
    paddingVertical: 12,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: C.edge,
    backgroundColor: 'transparent',
    alignItems: 'center',
    justifyContent: 'center',
  },
  undoBarPressed: { backgroundColor: C.edgeSoft },
  undoText: { color: C.inkMid, fontSize: 12, letterSpacing: 2, fontWeight: '600' },
  undoCountdown: { color: C.inkDim, fontSize: 9, letterSpacing: 1, marginTop: 2, fontVariant: ['tabular-nums'] },

  statsCard: {
    width: '100%',
    maxWidth: 520,
    alignSelf: 'center',
    marginTop: 8,
    padding: 16,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: C.edge,
    backgroundColor: C.face,
  },
  statsCardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    marginBottom: 12,
    paddingBottom: 10,
    borderBottomColor: C.edgeSoft,
    borderBottomWidth: 1,
  },
  statsCardTitle: { color: C.ink, fontSize: 22, fontWeight: '700', letterSpacing: 1, fontVariant: ['tabular-nums'] },
  statsCardSub: { color: C.inkDim, fontSize: 11, letterSpacing: 2, fontVariant: ['tabular-nums'] },
  statsCardCount: { color: C.accent, fontSize: 12, letterSpacing: 2, fontWeight: '600', fontVariant: ['tabular-nums'] },
  statsRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 4 },
  statsLabel: { color: C.inkDim, fontSize: 11, letterSpacing: 3, fontWeight: '600', width: 88 },
  statsValue: { color: C.ink, fontSize: 16, letterSpacing: 1, fontWeight: '600', fontVariant: ['tabular-nums'], flex: 1, textAlign: 'right' },
  statsValueMean: { fontSize: 22, fontWeight: '700' },
  statsHint: { color: C.inkMid, fontSize: 11, letterSpacing: 1.5, marginTop: 4, marginBottom: 6, textAlign: 'right', fontStyle: 'italic' },
  statsLast5Row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 6, paddingTop: 8, borderTopColor: C.edgeSoft, borderTopWidth: 1 },
  statsLast5Values: { flexDirection: 'row', gap: 6, flexWrap: 'wrap', flex: 1, justifyContent: 'flex-end' },
  statsLast5Item: { color: C.inkMid, fontSize: 12, fontWeight: '600', fontVariant: ['tabular-nums'], paddingHorizontal: 4 },
  statsEmptyCard: { color: C.inkDim, fontSize: 13, textAlign: 'center', letterSpacing: 1, paddingVertical: 24 },
  statsButtonRow: { flexDirection: 'row', gap: 10, marginTop: 14, paddingTop: 12, borderTopColor: C.edgeSoft, borderTopWidth: 1 },
  statsButton: { paddingHorizontal: 14, paddingVertical: 12, borderRadius: 4, borderWidth: 1, borderColor: C.edge, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  statsButtonPrimary: { borderColor: C.accent, backgroundColor: C.face },
  statsButtonDanger:  { borderColor: C.sharp,  backgroundColor: 'transparent' },
  statsButtonDangerArmed: { backgroundColor: C.dangerTint, borderColor: C.sharp },
  statsButtonPressed: { opacity: 0.7 },
  statsButtonText: { color: C.inkMid, fontSize: 11, letterSpacing: 2, fontWeight: '700' },
  statsButtonTextPrimary: { color: C.accent },
  statsButtonTextDanger:  { color: C.sharp },

  studentInput: {
    flex: 1,
    color: C.ink,
    fontSize: 14,
    letterSpacing: 0.5,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: C.edge,
    backgroundColor: C.bg,
    minHeight: 44,
  },
  studentAddBtn: { paddingHorizontal: 16, paddingVertical: 10, borderRadius: 4, borderWidth: 1, borderColor: C.accent, backgroundColor: C.face, alignItems: 'center', justifyContent: 'center', minHeight: 44, minWidth: 60 },
  studentAddBtnPressed: { backgroundColor: C.edge },
  studentAddBtnText: { color: C.accent, fontSize: 12, letterSpacing: 2, fontWeight: '700' },

  settingsGroup: { marginTop: 18 },
  settingsGroupLabel: { color: C.inkDim, fontSize: 9, letterSpacing: 3, marginBottom: 6, paddingBottom: 6, borderBottomColor: C.edgeSoft, borderBottomWidth: 1, fontWeight: '700' },
  settingsRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 10, paddingHorizontal: 4, minHeight: 44, gap: 12 },
  settingsRowLabel: { color: C.ink, fontSize: 13, letterSpacing: 1, flex: 1 },
  settingsRowHint: { color: C.inkDim, fontSize: 10, letterSpacing: 1, marginTop: 2 },
  settingsRowValue: { color: C.accent, fontSize: 13, fontWeight: '700', fontVariant: ['tabular-nums'], letterSpacing: 1, minWidth: 60, textAlign: 'right' },
  settingsToggle: { flexDirection: 'row', gap: 4 },
  settingsLinkBtn: { paddingHorizontal: 14, paddingVertical: 10, borderRadius: 4, borderWidth: 1, borderColor: C.edge, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  settingsLinkBtnPressed: { backgroundColor: C.edge },
  settingsLinkBtnText: { color: C.inkMid, fontSize: 12, letterSpacing: 2, fontWeight: '600' },
  settingsCloseBar: { marginTop: 16, paddingVertical: 14, borderRadius: 4, borderWidth: 1, borderColor: C.accent, backgroundColor: C.face, alignItems: 'center', justifyContent: 'center' },
  settingsCloseBarPressed: { opacity: 0.7 },
  settingsCloseText: { color: C.accent, fontSize: 12, letterSpacing: 3, fontWeight: '700' },

  collectActionRow: { flexDirection: 'row', gap: 10, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 8, paddingVertical: 6, flexWrap: 'wrap' },

  sessionStrip: { flexDirection: 'row', gap: 10, alignItems: 'center', justifyContent: 'center', paddingVertical: 8 },
  sessionChip: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, paddingVertical: 10, borderRadius: 4, borderWidth: 1, borderColor: C.edge, minHeight: 44 },
  sessionChipActive: { borderColor: C.inTune, backgroundColor: C.successTint },
  sessionChipPressed: { opacity: 0.7 },
  sessionChipText: { color: C.inkMid, fontSize: 12, letterSpacing: 2, fontWeight: '700' },
  sessionChipTextActive: { color: C.inTune },
  sessionEndBtn: { paddingHorizontal: 14, paddingVertical: 10, borderRadius: 4, borderWidth: 1, borderColor: C.sharp, minHeight: 44 },
  sessionEndBtnPressed: { opacity: 0.7 },
  sessionEndText: { color: C.sharp, fontSize: 11, letterSpacing: 2, fontWeight: '700' },

  gearIcon: { fontSize: 14, lineHeight: 14 },

  bottom: { flexDirection: 'row', alignItems: 'flex-start', gap: 24, borderTopColor: C.edgeSoft, borderTopWidth: 1, paddingTop: 12 },
  bottomLeft: { flex: 1 },
  controlsRow: { flexDirection: 'row', alignItems: 'flex-start', flexWrap: 'wrap', gap: 20, marginBottom: 4 },
  gainBlock: { flexDirection: 'column', gap: 4 },
  filterBlock: { flexDirection: 'column', gap: 4 },
  hiFiBlock: { flexDirection: 'column', gap: 4 },
  gainToggle: { flexDirection: 'row', gap: 4 },
  filterToggle: { flexDirection: 'row', gap: 4 },
  modeRow: { alignItems: 'center', paddingVertical: 12, gap: 14 },
  peakSlideHit: { alignItems: 'center' },
  peakSlideTrack: {
    width: PEAK_TRACK_WIDTH,
    height: PEAK_TRACK_HEIGHT,
    borderColor: C.edge,
    borderWidth: 1,
    borderRadius: PEAK_TRACK_HEIGHT / 2,
    backgroundColor: C.edgeSoft,
    position: 'relative',
    justifyContent: 'center',
  },
  peakSlideEndOff: { position: 'absolute', left: 18, color: C.inkVeryDim, fontSize: 12, letterSpacing: 2, fontWeight: '600' },
  peakSlideEndOn:  { position: 'absolute', right: 18, color: C.inkVeryDim, fontSize: 12, letterSpacing: 2, fontWeight: '600' },
  peakSlideEndOffActive: { color: C.inkVeryDim },
  peakSlideEndOnActive:  { color: C.inkVeryDim },
  peakSlideKnob: {
    position: 'absolute',
    top: PEAK_PAD,
    width: PEAK_KNOB_WIDTH,
    height: PEAK_TRACK_HEIGHT - PEAK_PAD * 2,
    borderRadius: (PEAK_TRACK_HEIGHT - PEAK_PAD * 2) / 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  peakSlideKnobText: { color: C.ink, fontSize: 13, letterSpacing: 2, fontWeight: '700' },
  peakSlideKnobTextActive: { color: C.bg },

  lowCutRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  lowCutLabel: { color: C.inkMid, fontSize: 11, letterSpacing: 3, fontWeight: '600' },
  lowCutValue: { color: C.ink, fontSize: 13, fontWeight: '700', minWidth: 56, textAlign: 'center', fontVariant: ['tabular-nums'] },
  lowCutStep: { width: H.stepper, height: H.stepper, borderRadius: H.stepper / 2, borderColor: C.edge, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  lowCutStepPressed: { opacity: 0.6 },
  lowCutStepText: { color: C.ink, fontSize: 20, lineHeight: 22, fontWeight: '700' },
  // #11 Fix 3 — uniform 'arrow disabled at its bound' treatment. Mirrors
  // logCtaBarDisabled (opacity 0.4 + dim border) so a stepper sitting at its
  // min/max reads the same way CLEAR does when disabled. Size-neutral (no
  // width/height/padding/border-width) so the 44dp touch target never shifts —
  // only opacity + border colour change.
  lowCutStepDisabled: { opacity: 0.3, borderColor: C.edgeSoft },
  gainPill: { minWidth: 64, height: H.pillHeight, paddingHorizontal: 14, borderColor: C.edge, borderWidth: 1, borderRadius: 4, alignItems: 'center', justifyContent: 'center' },
  gainPillActive: { backgroundColor: C.accent, borderColor: C.accent },
  gainPillPressed: { opacity: 0.7 },
  gainPillText: { color: C.inkMid, fontSize: 12, letterSpacing: 2, fontWeight: '700' },
  gainPillTextActive: { color: C.onAccent },
  filterPill: { minWidth: 78, height: H.pillHeight, paddingHorizontal: 14, borderColor: C.edge, borderWidth: 1, borderRadius: 4, alignItems: 'center', justifyContent: 'center' },
  filterPillActive: { backgroundColor: C.accent, borderColor: C.accent },
  filterPillText: { color: C.inkMid, fontSize: 12, letterSpacing: 2, fontWeight: '700' },
  filterPillTextActive: { color: C.onAccent },
  bottomLabel: { color: C.inkDim, fontSize: 10, letterSpacing: 3, marginBottom: 2 },
  meterLabel: { marginTop: 8 },
  meterTrack: { height: 12, backgroundColor: C.bg, borderColor: C.edge, borderWidth: 1, borderRadius: 1, overflow: 'hidden', position: 'relative' },
  // v0.9.8 — colored zones underneath the fill. Standard digital-meter
  // convention: green up to -12 dB (0–80 % of a 60 dB scale), amber to
  // -3 dB (80–95 %), red to 0 dB (95–100 %). All three zones are always
  // rendered at full width; the `meterDim` overlay above darkens the
  // portion BEYOND the current fill, so only zones up-to-fill are visible.
  meterZoneGreen: { position: 'absolute', top: 0, bottom: 0, left: '0%',  width: '80%', backgroundColor: C.inTune, opacity: 0.85 },
  meterZoneAmber: { position: 'absolute', top: 0, bottom: 0, left: '80%', width: '15%', backgroundColor: C.accent, opacity: 0.9 },
  meterZoneRed:   { position: 'absolute', top: 0, bottom: 0, left: '95%', width: '5%',  backgroundColor: C.sharp,  opacity: 0.9 },
  // Dim overlay — `left` is animated to current fill %, `right: 0` fixed.
  meterDim:       { position: 'absolute', top: 0, bottom: 0, right: 0, backgroundColor: C.bg, opacity: 0.82 },
  meterFill: { position: 'absolute', left: 0, top: 0, bottom: 0, backgroundColor: C.accent, opacity: 0.85 },
  peakMark: { position: 'absolute', top: 0, bottom: 0, width: 2, backgroundColor: C.ink, zIndex: 5 },
  meterTick: { position: 'absolute', top: 0, bottom: 0, width: 1, backgroundColor: C.inkDim, opacity: 0.7, zIndex: 4 },
  meterTickHot: { position: 'absolute', top: 0, bottom: 0, width: 1, backgroundColor: C.sharp, opacity: 0.8, zIndex: 4 },
  // v0.9.8 — scale labels positioned by absolute % offsets aligned to the
  // tick positions, not space-between. Previously "-6 dB" labelled the
  // 100 % column despite its tick sitting at 90 %.
  meterScale: { position: 'relative', height: 14, marginTop: 4 },
  meterScaleLabel: { position: 'absolute', top: 0, color: C.inkDim, fontSize: 9, letterSpacing: 1, fontVariant: ['tabular-nums'] },
  meterScaleLabelHot: { color: C.sharp, fontWeight: '700' },
  meterScaleTick: { color: C.inkDim, fontSize: 9, letterSpacing: 1, fontVariant: ['tabular-nums'] },
  meterScaleTickHot: { color: C.accent },
  bottomRight: { alignItems: 'flex-end', minWidth: 120 },
  dbValue: { color: C.inkMid, fontSize: 18, letterSpacing: 1, fontVariant: ['tabular-nums'] },
  dbUnit: { color: C.inkDim, fontSize: 11, letterSpacing: 2 },
  stage: { color: C.inkDim, fontSize: 10, letterSpacing: 2, marginTop: 4 },
  diag: { alignItems: 'center', marginTop: 6, paddingTop: 6, borderTopColor: C.edge, borderTopWidth: 1 },
  diagText: { color: C.inkDim, fontSize: 9, letterSpacing: 2, fontVariant: ['tabular-nums'] },

  pickerBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.72)', justifyContent: 'flex-end' },
  modalRoot: { flex: 1, backgroundColor: 'rgba(0,0,0,0.72)', justifyContent: 'flex-end' },
  pickerSheet: { backgroundColor: C.face, borderTopColor: C.edge, borderTopWidth: 1, borderTopLeftRadius: 6, borderTopRightRadius: 6, maxHeight: '75%', paddingBottom: 0 },
  pickerHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20, paddingVertical: 14, borderBottomColor: C.edgeSoft, borderBottomWidth: 1 },
  pickerTitle: { color: C.ink, fontSize: 13, letterSpacing: 4, fontWeight: '700' },
  pickerClose: { width: H.touchTarget, height: H.touchTarget, alignItems: 'center', justifyContent: 'center', borderColor: C.edge, borderWidth: 1, borderRadius: 4 },
  pickerCloseText: { color: C.inkMid, fontSize: 16, fontWeight: '700' },
  pickerScroll: { paddingHorizontal: 20 },
  pickerFamily: { marginTop: 16 },
  pickerFamilyLabel: { color: C.inkDim, fontSize: 9, letterSpacing: 3, marginBottom: 4, paddingBottom: 4, borderBottomColor: C.edgeSoft, borderBottomWidth: 1 },
  pickerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 12, paddingHorizontal: 8, borderRadius: 2, minHeight: 44 },
  pickerRowSelected: { backgroundColor: C.edgeSoft },
  pickerRowPressed: { backgroundColor: C.edge },
  pickerRowText: { color: C.inkMid, fontSize: 13, letterSpacing: 1 },
  pickerRowTextSelected: { color: C.accent, fontWeight: '600' },
  pickerRowCheck: { color: C.accent, fontSize: 10 },

  gate: { flex: 1, paddingVertical: 32, alignItems: 'center', justifyContent: 'center' },
  gateTitle: { color: C.ink, fontSize: 16, letterSpacing: 4, marginBottom: 16 },
  gateBody: { color: C.inkMid, fontSize: 14, lineHeight: 22, textAlign: 'center', maxWidth: 480, marginBottom: 16 },
  gateHint: { color: C.inkDim, fontSize: 12, lineHeight: 18, textAlign: 'center', maxWidth: 480, letterSpacing: 1 },
  gateReason: { color: C.inkVeryDim, fontSize: 11, fontFamily: 'monospace', marginTop: 12, textAlign: 'center', maxWidth: 480 },
  gateActions: { flexDirection: 'row', gap: 12, marginTop: 24 },
  gateButton: { paddingHorizontal: 20, paddingVertical: 12, borderRadius: 4, borderWidth: 1, minWidth: 160, alignItems: 'center' },
  gateButtonPrimary: { backgroundColor: C.accent, borderColor: C.accent },
  gateButtonSecondary: { backgroundColor: 'transparent', borderColor: C.edge },
  gateButtonPressed: { opacity: 0.7 },
  gateButtonTextPrimary: { color: C.bg, fontSize: 12, letterSpacing: 3, fontWeight: '600' },
  gateButtonTextSecondary: { color: C.ink, fontSize: 12, letterSpacing: 3 },
  gateFooter: { alignItems: 'flex-end', borderTopColor: C.edgeSoft, borderTopWidth: 1, paddingTop: 12 },

  oorPill: { marginTop: 12, paddingHorizontal: 10, paddingVertical: 4, borderColor: C.warnBorder, borderWidth: 1, borderRadius: 2, backgroundColor: C.warnBg },
  oorPillText: { color: C.accent, fontSize: 9, letterSpacing: 3, fontWeight: '600' },

  iconBtn: { minWidth: H.touchTarget, height: H.touchTarget, paddingHorizontal: 8, borderColor: C.edge, borderWidth: 1, borderRadius: 4, alignItems: 'center', justifyContent: 'center' },
  iconBtnPressed: { backgroundColor: C.edge },
  iconBtnText: { color: C.inkMid, fontSize: 11, letterSpacing: 2, fontWeight: '600' },

  primaryNavRow: { flexDirection: 'row', gap: 12, paddingHorizontal: 4, paddingVertical: 8 },
  primaryNavBtn: { flex: 1, minHeight: H.primaryNav, borderColor: C.edge, borderWidth: 1, borderRadius: 4, alignItems: 'center', justifyContent: 'center', backgroundColor: C.face },
  primaryNavBtnPressed: { backgroundColor: C.edge },
  primaryNavBtnText: { color: C.ink, fontSize: 14, letterSpacing: 4, fontWeight: '700' },

  topRow1: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8, paddingVertical: 2 },
  topRow1Right: { flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 0 },
  topRow2: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8, paddingTop: 4 },

  topNavRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingTop: 8, paddingBottom: 2 },

  statusDotLarge: { width: 14, height: 14, borderRadius: 7, backgroundColor: C.accent },
  statusCaption: { color: C.inkDim, fontSize: 10, letterSpacing: 2, marginTop: 2, textAlign: 'right' },

  audioSourceLabel: { color: C.inkVeryDim, fontSize: 9, letterSpacing: 2, marginTop: 2, marginBottom: 2, fontVariant: ['tabular-nums'] },
  hiFiFallbackText: { color: C.accent, fontSize: 9, letterSpacing: 1, opacity: 0.75, marginTop: 1, marginBottom: 2 },

  // ---------------------------------------------------------------------
  // v0.9.0 — new tab system: METRO + DECK + DRONE styles
  // ---------------------------------------------------------------------

  // Big screen-title header used by METRO + DECK + SETUP. Replaces what was
  // a modal title bar; lives at the top of the screen body.
  screenHeader: {
    paddingTop: 8,
    paddingBottom: 12,
    borderBottomColor: C.edgeSoft,
    borderBottomWidth: 1,
    marginBottom: 12,
  },
  screenTitle: { color: C.ink, fontSize: 18, letterSpacing: 6, fontWeight: '800' },
  screenSubtitle: { color: C.inkDim, fontSize: 11, letterSpacing: 2, marginTop: 4 },

  // Scrollable body used by the SETUP screen — replaces what the Modal-based
  // ScrollView wrapper provided.
  screenScroll: { flex: 1 },
  screenScrollContent: { paddingBottom: 24 },

  // METRO ----------------------------------------------------------------
  // v0.9.8 — BPM numeral + stepper buttons live on a single row, with the
  // steppers FLANKING the number rather than sitting below it. This makes
  // them feel like the BPM's satellite controls (real hardware metronomes
  // put +/− right next to the tempo readout) instead of an editor panel
  // that interrupts the eye path between BPM and the beat visual.
  metroBpmRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10, marginTop: 4 },
  metroBpmFlankStepper: {
    minWidth: 48,
    minHeight: 48,
    paddingHorizontal: 10,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: C.edge,
    alignItems: 'center',
    justifyContent: 'center',
  },
  metroBpmFlankStepperAccent: { borderColor: C.accent },
  metroBpmFlankStepperPressed: { backgroundColor: C.edge },
  metroBpmFlankStepperText: { color: C.ink, fontSize: 14, fontWeight: '700', letterSpacing: 1 },
  metroBpmFlankStepperTextAccent: { color: C.accent },
  // BPM tightened from 88/92 → 64/68 — the heroic display was eating ~24dp
  // that MetroScreen needed to stay inside the body budget on Pixel 9 Pro.
  // v0.9.9 — minWidth:180 removed: with 4 flank steppers (48dp each) + gaps
  // it pushed the row past 360dp on small phones. tabular-nums keeps the
  // numeral steady as it counts without reserving a fixed slot.
  metroBpmDisplay: {
    color: C.ink,
    fontSize: 64,
    fontWeight: '300',
    letterSpacing: -1,
    fontVariant: ['tabular-nums'],
    lineHeight: 68,
    textAlign: 'center',
  },
  metroBpmUnit: { color: C.inkDim, fontSize: 14, letterSpacing: 4, marginTop: -6 },
  metroBpmStepRow: { flexDirection: 'row', justifyContent: 'center', gap: 8, marginTop: 8, flexWrap: 'wrap' },
  metroStepBtn: {
    minWidth: 64,
    minHeight: H.touchTarget,
    paddingHorizontal: 14,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: C.edge,
    backgroundColor: C.bg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  metroStepBtnAccent: { borderColor: C.accent },
  metroStepBtnPressed: { backgroundColor: C.edge },
  metroStepBtnText: { color: C.ink, fontSize: 16, fontWeight: '700', letterSpacing: 1 },
  metroStepBtnTextAccent: { color: C.accent },

  metroIndicator: {
    width: 96,
    height: 96,
    borderRadius: 48,
    alignSelf: 'center',
    marginTop: 16,
    marginBottom: 16,
    borderWidth: 2,
    borderColor: C.edge,
    alignItems: 'center',
    justifyContent: 'center',
  },
  metroIndicatorOn: { backgroundColor: C.accent, borderColor: C.accent },
  metroIndicatorAccentOn: { backgroundColor: C.inTune, borderColor: C.inTune },
  metroIndicatorBeat: { color: C.inkMid, fontSize: 22, fontWeight: '700', letterSpacing: 2, fontVariant: ['tabular-nums'] },
  metroIndicatorBeatOn: { color: C.onAccent },

  metroTimeSigRow: { flexDirection: 'row', justifyContent: 'center', gap: 8, marginTop: 4, flexWrap: 'wrap' },
  metroSigPill: { minWidth: 56, height: H.pillHeight, paddingHorizontal: 10, borderColor: C.edge, borderWidth: 1, borderRadius: 4, alignItems: 'center', justifyContent: 'center' },
  metroSigPillActive: { backgroundColor: C.accent, borderColor: C.accent },
  metroSigPillText: { color: C.inkMid, fontSize: 13, letterSpacing: 1, fontWeight: '700', fontVariant: ['tabular-nums'] },
  metroSigPillTextActive: { color: C.onAccent },

  metroTap: {
    marginTop: 12,
    paddingVertical: 14,
    paddingHorizontal: 20,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: C.accent,
    backgroundColor: C.face,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 56,
  },
  metroTapPressed: { backgroundColor: C.accentTint },
  metroTapText: { color: C.accent, fontSize: 14, letterSpacing: 4, fontWeight: '700' },
  metroTapHint: { color: C.inkDim, fontSize: 10, letterSpacing: 1, marginTop: 4 },

  // v0.9.8 — primary START/STOP gets the dominant treatment a real metronome's
  // start button has: minHeight 72, solid colored fill (not bordered), and
  // a larger font. Previously matched TAP's 56dp size and used a faint
  // background tint, so both buttons read as equal peers. Now START
  // unambiguously reads as the headline action.
  metroPrimary: {
    marginTop: 12,
    paddingVertical: 18,
    borderRadius: 6,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 72,
  },
  metroPrimaryIdle: { backgroundColor: C.accent },
  metroPrimaryActive: { backgroundColor: C.sharp },
  metroPrimaryPressed: { opacity: 0.8 },
  metroPrimaryText: { fontSize: 20, letterSpacing: 8, fontWeight: '800' },
  metroPrimaryTextIdle: { color: C.onAccent },
  metroPrimaryTextActive: { color: C.bg },

  metroLabel: { color: C.inkDim, fontSize: 10, letterSpacing: 3, marginTop: 12, textAlign: 'center', fontWeight: '700' },

  // DECK ----------------------------------------------------------------
  deckBody: { flex: 1, paddingTop: 8 },
  deckClock: {
    color: C.ink,
    fontSize: 56,
    fontWeight: '300',
    letterSpacing: 4,
    fontVariant: ['tabular-nums'],
    textAlign: 'center',
    marginTop: 24,
    marginBottom: 12,
  },
  deckClockRecording: { color: C.sharp },
  deckStatusLine: { color: C.inkDim, fontSize: 11, letterSpacing: 3, textAlign: 'center', marginBottom: 24 },

  deckRecordBtn: {
    width: 140,
    height: 140,
    borderRadius: 70,
    alignSelf: 'center',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 4,
    borderColor: C.sharp,
    backgroundColor: C.dangerTint,
    marginVertical: 12,
  },
  deckRecordBtnActive: { backgroundColor: C.sharp },
  deckRecordBtnPressed: { opacity: 0.8 },
  // v0.9.8 — fontSize 14 → 22. The RECORD label was timid inside a 140dp
  // circle; on a real tape deck RECORD is the dominant typographic element.
  deckRecordBtnText: { color: C.sharp, fontSize: 22, letterSpacing: 4, fontWeight: '800' },
  deckRecordBtnTextActive: { color: C.bg },

  deckPlaybackCard: {
    marginTop: 24,
    padding: 16,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: C.edge,
    backgroundColor: C.bg,
  },
  deckPlayRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  deckPlayBtn: {
    width: 56, height: 56, borderRadius: 28,
    borderColor: C.accent, borderWidth: 2,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: C.face,
  },
  deckPlayBtnPressed: { opacity: 0.7 },
  deckPlayBtnText: { color: C.accent, fontSize: 22, fontWeight: '700' },
  // Scrubber rebuilt v0.9.8: previously the 20×20 knob was clipped by the
  // 12dp-tall track's `overflow: 'hidden'` and a `top: -4` that pushed it
  // above the rail. Net effect — the knob was invisible/non-functional.
  // Now the OUTER container is the gesture target (24dp tall for fingers),
  // the inner track holds only the fill (with rounded clipping), and the
  // knob is a sibling rendered ON TOP of the track so it can extend
  // visibly above and below.
  deckScrubOuter: { flex: 1, height: 24, justifyContent: 'center', position: 'relative' },
  deckScrubTrack: { height: 8, backgroundColor: C.edgeSoft, borderRadius: 4, overflow: 'hidden', position: 'relative' },
  deckScrubFill: { position: 'absolute', top: 0, bottom: 0, left: 0, backgroundColor: C.accent, opacity: 0.7 },
  deckScrubKnob: { position: 'absolute', top: 0, width: 24, height: 24, borderRadius: 12, backgroundColor: C.accent, marginLeft: -12, borderColor: C.face, borderWidth: 2 },
  deckTimecodes: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 6 },
  deckTimecode: { color: C.inkMid, fontSize: 11, fontVariant: ['tabular-nums'], letterSpacing: 1 },

  // v1.4 closeout (Frodo NOTE-2) — persistent inline error shown inside the
  // playback card when the take won't load into a player. Replaces the silent
  // dead loop where ▶ did nothing and just re-fired a transient toast. In-flow
  // (not the absolute deckToast) so it stays put with a CLEAR / re-record CTA.
  deckPlayError: {
    marginTop: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 4,
    borderWidth: 1,
    backgroundColor: C.dangerTint,
    borderColor: C.sharp,
    gap: 10,
  },
  deckPlayErrorText: { color: C.sharp, fontSize: 12, letterSpacing: 0.5, lineHeight: 18, fontWeight: '700' },

  // v0.9.8 — SAVE / CLEAR hierarchy rebuilt. Previously identical size
  // (minWidth 110, equal padding) — users went for SAVE on the right and
  // hit CLEAR by accident. Now SAVE has the dominant treatment (solid
  // accent fill, wider) and CLEAR is a smaller subordinate destructive
  // outlined button.
  deckActionRow: { flexDirection: 'row', gap: 10, marginTop: 16, justifyContent: 'center', flexWrap: 'wrap', alignItems: 'center' },
  deckActionBtn: { paddingHorizontal: 18, paddingVertical: 12, borderRadius: 4, borderWidth: 1, borderColor: C.edge, minHeight: 48, alignItems: 'center', justifyContent: 'center', minWidth: 110 },
  deckActionBtnPrimary: {
    backgroundColor: C.accent,
    borderColor: C.accent,
    minWidth: 160,
    minHeight: 52,
    paddingHorizontal: 24,
  },
  deckActionBtnDanger:  {
    backgroundColor: 'transparent',
    borderColor: C.sharp,
    minWidth: 80,
    minHeight: 48,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  deckActionBtnPressed: { opacity: 0.7 },
  deckActionBtnText: { color: C.inkMid, fontSize: 12, letterSpacing: 2, fontWeight: '700' },
  deckActionBtnTextPrimary: { color: C.onAccent, fontSize: 14, letterSpacing: 4, fontWeight: '800' },
  deckActionBtnTextDanger:  { color: C.sharp, fontSize: 11, letterSpacing: 2 },

  deckToast: {
    position: 'absolute',
    left: 16, right: 16, bottom: 16,
    paddingHorizontal: 14,
    paddingVertical: 10,
    backgroundColor: C.successTint,
    borderColor: C.inTune,
    borderWidth: 1,
    borderRadius: 4,
  },
  deckToastError: { backgroundColor: C.dangerTint, borderColor: C.sharp },
  deckToastText: { color: C.inTune, fontSize: 12, letterSpacing: 1, textAlign: 'center', fontWeight: '700' },
  deckToastTextError: { color: C.sharp },

  deckEmpty: {
    marginTop: 32,
    paddingHorizontal: 24,
    alignItems: 'center',
  },
  deckEmptyText: { color: C.inkDim, fontSize: 13, letterSpacing: 1, textAlign: 'center', lineHeight: 22 },

  // Absolute overlay — covers the whole DeckScreen body. Was `flex: 1` until
  // v0.9.5, which made it render as an in-flow sibling under the playback
  // card. That left the rest of the deck tappable BEHIND the "confirm
  // discard" prompt; a user could fire off RECORD a second time and lose
  // the take they were being asked about. Absolute positioning fixes the
  // real-modal expectation.
  deckConfirmRoot: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.72)', alignItems: 'center', justifyContent: 'center', paddingHorizontal: 24 },
  deckConfirmCard: { width: '100%', maxWidth: 360, padding: 20, borderRadius: 6, borderWidth: 1, borderColor: C.edge, backgroundColor: C.face },
  deckConfirmTitle: { color: C.ink, fontSize: 14, letterSpacing: 3, fontWeight: '700', marginBottom: 8 },
  deckConfirmBody: { color: C.inkMid, fontSize: 13, letterSpacing: 0.5, lineHeight: 20, marginBottom: 16 },
  deckConfirmRow: { flexDirection: 'row', gap: 10, justifyContent: 'flex-end' },

  // DRONE (tuner-screen pill + inline controls) -------------------------
  droneBar: {
    marginTop: 4,
    marginBottom: 4,
    paddingHorizontal: 8,
    paddingVertical: 6,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: C.edgeSoft,
    backgroundColor: C.bg,
    gap: 8,
  },
  dronePill: {
    minHeight: 48,
    paddingHorizontal: 18,
    paddingVertical: 10,
    borderRadius: 24,
    borderWidth: 1,
    borderColor: C.edge,
    backgroundColor: C.face,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 10,
    alignSelf: 'center',
    minWidth: 200,
  },
  dronePillActive: { borderColor: C.inTune, backgroundColor: C.successTint },
  dronePillPressed: { opacity: 0.75 },
  dronePillText: { color: C.inkMid, fontSize: 13, letterSpacing: 3, fontWeight: '700' },
  dronePillTextActive: { color: C.inTune },
  dronePillDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: C.inkVeryDim },
  dronePillDotActive: { backgroundColor: C.inTune },
  dronePillWaiting: { borderColor: C.sharp, backgroundColor: 'transparent' },
  dronePillDotWaiting: { backgroundColor: C.sharp },
  dronePillTextWaiting: { color: C.sharp, letterSpacing: 1.2, fontSize: 10 },

  droneControlsRow: { flexDirection: 'row', justifyContent: 'space-around', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginTop: 4 },
  droneControl: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  droneControlLabel: { color: C.inkDim, fontSize: 10, letterSpacing: 2, fontWeight: '700' },
  droneControlValue: { color: C.ink, fontSize: 13, letterSpacing: 1, fontVariant: ['tabular-nums'], fontWeight: '700', minWidth: 44, textAlign: 'center' },

  // ---------------------------------------------------------------------------
  // setupVoice* — v1.1 DRONE voice picker (SetupScreen only)
  // ---------------------------------------------------------------------------

  // Horizontal pill row; wrap handles >5 presets or small phones.
  setupVoicePresetRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingVertical: 8, paddingHorizontal: 4 },

  // Small italic line shown when a non-preset GM voice is active.
  setupVoiceSelectedHint: { color: C.inkDim, fontSize: 11, letterSpacing: 1, fontStyle: 'italic', paddingHorizontal: 4, marginBottom: 4 },

  // "More voices" expand toggle — text-link feel, no border, left-aligned.
  setupVoiceMoreBtn: { paddingVertical: 8, paddingHorizontal: 4 },
  setupVoiceMoreText: { color: C.accent, fontSize: 12, letterSpacing: 2, fontWeight: '600' },

  // Outer wrapper caps the GM list height so the user can flick through 128
  // entries without the outer SETUP ScrollView growing to fill all of them.
  setupVoiceListWrap: { maxHeight: 360, marginTop: 4, borderColor: C.edgeSoft, borderWidth: 1, borderRadius: 4, overflow: 'hidden' },
  setupVoiceListScroll: { flex: 1 },

  // Individual GM list row.
  setupVoiceGmRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 9, paddingHorizontal: 10, minHeight: 40 },
  setupVoiceGmRowSelected: { backgroundColor: C.accentTint },
  setupVoiceGmRowPressed: { backgroundColor: C.edgeSoft },

  // Program number — fixed-width tabular so labels align cleanly.
  setupVoiceGmProgram: { color: C.inkDim, fontSize: 11, fontVariant: ['tabular-nums'], letterSpacing: 1, minWidth: 28 },
  setupVoiceGmLabel: { color: C.inkMid, fontSize: 13, letterSpacing: 0.5, flex: 1 },

  // ---------------------------------------------------------------------------
  // v1.2 — METRO additions
  // metro2_*       — METRO tab additions (CUSTOM pill spacer)
  // customTimeSig_*— CustomTimeSigPanel
  // setupMetro2_*  — METRO VOICES group on SETUP
  // perBeat_*      — PerBeatRow cells
  // subdivPicker_* — SubdivisionPicker rows
  // ---------------------------------------------------------------------------

  // Invisible spacer that reserves the CUSTOM panel's height when CUSTOM is
  // NOT active. Keeps the layout below the time-sig row anchored so flipping
  // the CUSTOM pill never shifts START/STOP up/down (§10 anti-flicker).
  metro2_customSpacer: { height: 60 },

  // CustomTimeSigPanel ------------------------------------------------------
  customTimeSig_row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    marginTop: 6,
    minHeight: 52,
  },
  customTimeSig_cluster: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  customTimeSig_label: {
    color: C.inkDim,
    fontSize: 10,
    letterSpacing: 2,
    fontWeight: '700',
    marginRight: 2,
  },
  // Direct-entry field. Fixed width keeps the layout from shifting when the
  // user types 1- vs 2-digit values (tabular-nums + minWidth).
  customTimeSig_input: {
    minWidth: 44,
    height: 44,
    paddingHorizontal: 6,
    borderColor: C.edge,
    borderWidth: 1,
    borderRadius: 4,
    backgroundColor: C.face,
    color: C.ink,
    fontSize: 16,
    fontWeight: '700',
    letterSpacing: 1,
    textAlign: 'center',
    fontVariant: ['tabular-nums'],
  },

  // SETUP — METRO VOICES group helpers --------------------------------------
  setupMetro2_subLabel: {
    color: C.inkDim,
    fontSize: 10,
    letterSpacing: 2,
    fontWeight: '700',
    marginTop: 10,
    marginBottom: 6,
  },
  setupMetro2_section: { marginTop: 4 },

  // PerBeatRow --------------------------------------------------------------
  perBeat_row: {
    flexDirection: 'row',
    gap: 6,
    paddingVertical: 6,
    paddingHorizontal: 2,
  },
  perBeat_scrollOuter: { paddingVertical: 6 },
  perBeat_scrollContent: { gap: 6, paddingHorizontal: 2 },
  // Cell: ≥48dp touch target (Aragorn §15.Q11.5), fixed 56dp width so the
  // drum short label has stable room and the row math at high N is sane.
  perBeat_cell: {
    width: 56,
    minHeight: 56,
    borderColor: C.edge,
    borderWidth: 1,
    borderRadius: 4,
    backgroundColor: C.face,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 6,
    paddingHorizontal: 4,
    gap: 4,
  },
  // Beat-1 marker — permanent left accent stripe regardless of drum.
  perBeat_cellDownbeat: {
    borderLeftWidth: 3,
    borderLeftColor: C.accent,
  },
  // Live-flash: BORDER COLOR SWAP ONLY. No opacity/background animation
  // (§15.Q11.12 Legolas constraint). Pure render-time prop.
  perBeat_cellLive: {
    borderColor: C.inTune,
  },
  perBeat_cellPressed: { backgroundColor: C.edgeSoft },
  perBeat_beatNumber: {
    color: C.inkDim,
    fontSize: 12,
    letterSpacing: 1,
    fontVariant: ['tabular-nums'],
    fontWeight: '700',
  },
  perBeat_drumLabel: {
    color: C.ink,
    fontSize: 11,
    letterSpacing: 1,
    fontWeight: '700',
    textAlign: 'center',
  },

  // SubdivisionPicker -------------------------------------------------------
  subdivPicker_radioRow: {
    flexDirection: 'row',
    gap: 8,
    flexWrap: 'wrap',
    paddingVertical: 6,
  },
  // Tap row — looks like a settingsRow but is itself the Pressable. ≥48dp.
  subdivPicker_voiceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 12,
    paddingHorizontal: 4,
    minHeight: 48,
    borderTopColor: C.edgeSoft,
    borderTopWidth: 1,
    marginTop: 6,
    gap: 12,
  },
  subdivPicker_voiceRowPressed: { backgroundColor: C.edgeSoft },
  subdivPicker_voiceRowLabel: {
    color: C.ink,
    fontSize: 13,
    letterSpacing: 1,
  },
  subdivPicker_voiceRowValue: {
    color: C.accent,
    fontSize: 13,
    letterSpacing: 1,
    fontWeight: '700',
    flexShrink: 1,
    textAlign: 'right',
  },

  // ---------------------------------------------------------------------------
  // v1.3 — top-pill sub-nav + profile slot grid + profile editor accordion
  // topPillNav_*    — TopPillNav (sub-page nav under TopBar)
  // profileSlot_*   — ProfileSlotGrid (METRONOME bottom 2×4 row)
  // profileEditor_* — ProfileEditorAccordion (CUSTOMIZATION editor)
  // ---------------------------------------------------------------------------

  // TopPillNav — equal-width split, fixed height. Reserves identical height
  // across sub-page swaps so toggling never moves siblings (anti-flicker).
  // v1.3.2 — drop the prior paddingHorizontal: 2 so the pill row's left edge
  // aligns with the BPM ± buttons + Beat-pattern row below (both share the
  // scene's 24dp gutter). The 2dp inset made the pills look 22dp narrower
  // per side than the content beneath because the inner pill borders +
  // accent fill landed a hair short of the BPM stepper's accent borders.
  topPillNav_row: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 4,
    marginBottom: 6,
  },
  topPillNav_pill: {
    flex: 1,
    minHeight: 48,
    borderColor: C.edge,
    borderWidth: 1,
    borderRadius: 4,
    alignItems: 'center',
    justifyContent: 'center',
  },
  topPillNav_pillActive: {
    backgroundColor: C.accent,
    borderColor: C.accent,
  },
  topPillNav_pillPressed: { opacity: 0.7 },
  topPillNav_pillText: {
    color: C.inkMid,
    fontSize: 13,
    letterSpacing: 3,
    fontWeight: '700',
  },
  topPillNav_pillTextActive: { color: C.onAccent },

  // ProfileSlotGrid — 2 rows of 4 pills each. Row pills use flex:1 so the
  // four pills share the row width equally; height locked to the metroSigPill
  // height so the bottom of METRONOME stays a fixed 2-row footer.
  profileSlot_grid: {
    marginTop: 4,
    paddingHorizontal: 2,
    gap: 6,
  },
  profileSlot_row: {
    flexDirection: 'row',
    gap: 6,
  },
  // Each pill flexes to share its row's width. metroSigPill provides the
  // base look + height (44dp); v1.3.2 bumps the local override to 48dp to
  // meet the HIG minimum touch target on the 2×4 grid.
  profileSlot_pill: {
    flex: 1,
    minWidth: 0, // allow truncation in narrow widths
    minHeight: 48,
    paddingHorizontal: 6,
  },
  // User-row visual variant — dashed border on idle so the user can see at a
  // glance which row is presets vs slots. Active state (metroSigPillActive)
  // overrides borderColor for selected slot, matching presets visually.
  profileSlot_pillUser: {
    borderStyle: 'dashed',
  },

  // ProfileEditorAccordion -------------------------------------------------
  // Top header (per U18 / §4): "CUSTOM SOUND SET · CUSTOM BEAT PATTERNS".
  profileEditor_header: {
    color: C.inkDim,
    fontSize: 10,
    letterSpacing: 3,
    fontWeight: '700',
    marginTop: 14,
    marginBottom: 6,
    paddingBottom: 6,
    borderBottomColor: C.edgeSoft,
    borderBottomWidth: 1,
  },
  profileEditor_section: {
    marginBottom: 6,
    borderColor: C.edgeSoft,
    borderWidth: 1,
    borderRadius: 4,
    backgroundColor: C.face,
  },
  profileEditor_sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: 12,
    minHeight: 56,
    gap: 8,
  },
  profileEditor_sectionHeaderPressed: { backgroundColor: C.edgeSoft },
  profileEditor_sectionHeaderTitle: {
    color: C.ink,
    fontSize: 13,
    letterSpacing: 2,
    fontWeight: '700',
  },
  profileEditor_sectionHeaderSubtitle: {
    color: C.inkDim,
    fontSize: 11,
    letterSpacing: 1,
    marginTop: 2,
  },
  profileEditor_sectionHeaderChevron: {
    color: C.accent,
    fontSize: 16,
    fontWeight: '700',
    minWidth: 18,
    textAlign: 'right',
  },
  profileEditor_sectionBody: {
    paddingHorizontal: 12,
    paddingTop: 4,
    paddingBottom: 14,
    borderTopColor: C.edgeSoft,
    borderTopWidth: 1,
    gap: 4,
  },
  profileEditor_fieldLabel: {
    color: C.inkDim,
    fontSize: 10,
    letterSpacing: 2,
    fontWeight: '700',
    marginTop: 10,
    marginBottom: 4,
  },
  profileEditor_nameInput: {
    minHeight: 44,
    paddingHorizontal: 10,
    borderColor: C.edge,
    borderWidth: 1,
    borderRadius: 4,
    backgroundColor: C.bg,
    color: C.ink,
    fontSize: 14,
    fontWeight: '700',
    letterSpacing: 1,
  },
  // v1.4 closeout (Frodo NOTE-3) — tiny transient hint under the name field
  // when an empty blur is rejected (replaces the old silent rename to "User N").
  profileEditor_nameHint: {
    color: C.sharp,
    fontSize: 11,
    letterSpacing: 0.5,
    marginTop: 4,
  },
  profileEditor_tsKindRow: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 4,
  },
  profileEditor_tsPresetRow: {
    flexDirection: 'row',
    gap: 8,
    flexWrap: 'wrap',
    marginTop: 2,
  },
  // v1.3.2 — reserve a fixed height for the time-sig VALUE region inside
  // the accordion body so flipping PRESET↔CUSTOM doesn't shift the Beat
  // pattern / Subdivisions sections below it. Sized to the taller side:
  // CustomTimeSigPanel uses customTimeSig_row's minHeight 52 + its label
  // line + paddings ≈ 96dp, plus a 14dp buffer for ascender variance = 110.
  profileEditor_tsValueReserve: {
    minHeight: 110,
  },
  tunerSplitRow: { flex: 1, flexDirection: 'row', gap: 16 },
  tunerSplitVisual: { flex: 3, flexShrink: 1, justifyContent: 'center' },
  tunerSplitControls: { flex: 2, flexShrink: 1, justifyContent: 'flex-start' },
  tunerVisualPortrait: { flex: 1, flexShrink: 1 },
  });
}
