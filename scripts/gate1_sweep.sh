#!/usr/bin/env bash
# gate1_sweep.sh — #64 Phase-1 on-device bookended BPM sweep + logcat capture.
#
# Drives the BellCurve metronome across ~40<->240 BPM, holding each step long
# enough for a clean per-segment detrend, then a fast scrub, while the armed
# shadow probe streams `ShadowBeat` records to logcat (egress added in
# src/useMidiBus.ts). Pipe the capture into scripts/gate1_analyze.py.
#
# Key insight: each ShadowBeat carries periodNanos, so the analyzer derives the
# TRUE bpm (60e9/pn) per beat. The driver therefore does NOT need pixel-perfect
# BPM control — it just needs to MOVE bpm across the range with tens-of-sec
# holds. BPM is changed by COUNTING stepper taps (the metro screen has no
# slider: a [-5][-1][bpm][+1][+5] row calling metro.bumpBpm).
#
# Coords are for the 960x2142 input space and MUST be calibrated on-device:
#   ADB_DEVICE='...' ./gate1_sweep.sh calibrate   # labelled screencap -> read coords
#   ADB_DEVICE='...' ./gate1_sweep.sh run          # the sweep
#   python3 scripts/gate1_analyze.py "$OUT"/capture.log
#
# Prereqs: APK with 5ac659b (SHADOW_PROBE_ENABLED=true) installed; metro style
# = PENDULUM (so the #167 armPhase COARSE log also fires for criterion 3).
set -uo pipefail

ADB="${ADB:-/home/repro/android/platform-tools/adb}"
DEV="${ADB_DEVICE:-adb-48071FDAP0030Q-heCqEQ (2)._adb-tls-connect._tcp}"
PKG="com.knelsonb.intonationanalyzer"
OUT="${OUT:-/home/repro/code/bellcurve/docs/captures/64-gate1}"

# --- tap coords (960x2142) — CALIBRATE via `calibrate` then edit these -------
X_M5="${X_M5:-110}";  X_M1="${X_M1:-300}";  X_P1="${X_P1:-660}";  X_P5="${X_P5:-850}"
Y_BPM="${Y_BPM:-300}"                 # the BPM stepper row
X_PRIMARY="${X_PRIMARY:-480}"; Y_PRIMARY="${Y_PRIMARY:-1980}"   # START/STOP
X_METROTAB="${X_METROTAB:-170}"; Y_TABBAR="${Y_TABBAR:-2080}"   # METRO bottom tab

HOLD="${HOLD:-25}"                    # seconds per steady step (>= tens-of-sec)
SETTLE="${SETTLE:-2}"
BPM_MIN="${BPM_MIN:-40}"; BPM_MAX="${BPM_MAX:-240}"

a(){ "$ADB" -s "$DEV" "$@"; }
tap(){ a shell input tap "$1" "$2"; sleep 0.25; }
tapn(){ local n="$1" x="$2" y="$3"; for ((i=0;i<n;i++)); do tap "$x" "$y"; done; }
log(){ printf '[sweep] %s\n' "$*"; }

foreground(){ a shell monkey -p "$PKG" -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1; sleep 2; }

calibrate(){
  mkdir -p "$OUT"; foreground; tap "$X_METROTAB" "$Y_TABBAR"; sleep 1
  a exec-out screencap -p > "$OUT/metro-calib.png"
  log "screencap -> $OUT/metro-calib.png — read the [-5][-1][bpm][+1][+5] row + START/STOP coords, then edit the X_*/Y_* defaults."
}

run(){
  mkdir -p "$OUT"
  foreground
  tap "$X_METROTAB" "$Y_TABBAR"; sleep 1
  log "flooring BPM to the clamp (-5 x 50)"
  tapn 50 "$X_M5" "$Y_BPM"          # clamp down to BPM_MIN (driver doesn't read bpm; analyzer does)
  a shell logcat -c
  log "START metro"; tap "$X_PRIMARY" "$Y_PRIMARY"; sleep "$SETTLE"
  # --- bookended steady sweep: hold MIN, then +30 chunks up to MAX ---
  local chunks=$(( (BPM_MAX - BPM_MIN) / 30 + 1 ))
  log "hold @~${BPM_MIN} for ${HOLD}s"; sleep "$HOLD"
  for ((c=0;c<chunks;c++)); do
    tapn 6 "$X_P5" "$Y_BPM"         # +30 BPM
    log "hold step $((c+1))/$chunks (~+30 BPM) for ${HOLD}s"; sleep "$HOLD"
  done
  # --- SCRUB: rapid up/down across the range for the head-to-head (criterion 3) ---
  log "scrub x3 (fast +/- across range)"
  for ((s=0;s<3;s++)); do tapn 40 "$X_M5" "$Y_BPM"; tapn 40 "$X_P5" "$Y_BPM"; done
  sleep "$SETTLE"
  log "STOP metro"; tap "$X_PRIMARY" "$Y_PRIMARY"
  # captures all 3 criteria: ShadowBeat (floor), 'gate1 clock-identity' one-shot
  # (criterion 1, native Log.i), PendDiag/armPhase (#167 head-to-head, criterion 3).
  a shell logcat -d | grep -E "ShadowBeat|gate1 clock-identity|PendDiag|armPhase|phaseErr" > "$OUT/capture.log"
  log "captured $(wc -l < "$OUT/capture.log") matching logcat lines -> $OUT/capture.log"
  log "analyze: python3 scripts/gate1_analyze.py '$OUT/capture.log'"
}

case "${1:-run}" in
  calibrate) calibrate ;;
  run)       run ;;
  *) echo "usage: $0 [calibrate|run]"; exit 2 ;;
esac
