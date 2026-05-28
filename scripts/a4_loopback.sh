#!/usr/bin/env bash
# a4_loopback.sh — A4=442 acoustic-loopback acceptance on-device (task #1).
#
# Drone -> speaker -> mic -> tuner, on the one device. Captures per-leg evidence,
# DEMONSTRATED-not-inferred (Frodo-LOTC's bar, docs/64-ux-read-leg-protocol.md):
#   SEE    — A=442 shown on the tuner bar.
#   HEAR   — tuner cents/Hz read off the acoustic loopback (+ the VU off the noise
#            floor proves the mic actually heard the speaker).
#   RECORD — tap-to-log -> logged cents (screencap + logcat).
#   BASELINE — pre-A4 build: NOT available here, so we can only claim CURRENT
#            behavior, never that the fix CHANGED it. Say so; never a green "PASS".
#
# Discriminator at A=442: a CONSISTENT drone reads ~0c on the tuner (the D1
# 2x-pitchBend fix holds); ~+8c SHARP would be the bug. Hz ~442 = absolute confirm.
#
# Coords (960x2142 input space) calibrate on-device: `a4_loopback.sh calibrate`.
set -uo pipefail
ADB="${ADB:-/home/repro/android/platform-tools/adb}"
DEV="${ADB_DEVICE:-adb-48071FDAP0030Q-heCqEQ (2)._adb-tls-connect._tcp}"
PKG="com.knelsonb.intonationanalyzer"
OUT="${OUT:-/home/repro/code/bellcurve/docs/captures/64-a4-loopback}"

X_TUNERTAB="${X_TUNERTAB:-60}";  Y_TABBAR="${Y_TABBAR:-2080}"   # TUNER bottom tab
X_DRONE="${X_DRONE:-480}";       Y_DRONE="${Y_DRONE:-1694}"     # DRONE OFF/ON button
X_TAPLOG="${X_TAPLOG:-480}";     Y_TAPLOG="${Y_TAPLOG:-1352}"   # TAP-TO-LOG bar
SETTLE="${SETTLE:-3}"

a(){ "$ADB" -s "$DEV" "$@"; }
tap(){ a shell input tap "$1" "$2"; sleep 0.4; }
shot(){ a exec-out screencap -p > "$OUT/$1"; echo "  shot -> $OUT/$1"; }
log(){ printf '[a4] %s\n' "$*"; }
foreground(){ a shell monkey -p "$PKG" -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1; sleep 2; }

calibrate(){
  mkdir -p "$OUT"; foreground; tap "$X_TUNERTAB" "$Y_TABBAR"; sleep 1; shot "tuner-calib.png"
  log "read TUNER-tab / DRONE / TAP-TO-LOG coords + the A= readout from the shot, then edit X_*/Y_*."
}

run(){
  mkdir -p "$OUT"; foreground; tap "$X_TUNERTAB" "$Y_TABBAR"; sleep 1
  log "SEE leg — A= readout + tuner idle"; shot "00-see.png"
  # bump media volume so the speaker is audible to the mic ('media' CLI absent here)
  for ((i=0;i<8;i++)); do a shell input keyevent KEYCODE_VOLUME_UP; done
  a shell logcat -c
  log "DRONE ON"; tap "$X_DRONE" "$Y_DRONE"; sleep "$SETTLE"
  log "HEAR leg — tuner reading off the loopback (cents/Hz + VU)"; shot "01-hear.png"
  log "RECORD leg — tap-to-log"; tap "$X_TAPLOG" "$Y_TAPLOG"; sleep 1; shot "02-record.png"
  a shell logcat -d | grep -iE "tuner|cent|collect|a4|442|detect|pitch" > "$OUT/record.log" 2>/dev/null || true
  log "DRONE OFF"; tap "$X_DRONE" "$Y_DRONE"
  echo
  log "READ THE SHOTS — report per-leg, DEMONSTRATED-not-inferred:"
  log "  SEE    -> $OUT/00-see.png   (A=442 shown?)"
  log "  HEAR   -> $OUT/01-hear.png  (cents ~0 = D1 fix consistent / ~+8c = bug; Hz ~442 = absolute; VU off the floor = mic heard it)"
  log "  RECORD -> $OUT/02-record.png + $OUT/record.log  (logged cents)"
  log "  BASELINE: pre-A4 build NOT available -> claim CURRENT behavior only, never that the fix CHANGED it."
}
case "${1:-run}" in calibrate) calibrate;; run) run;; *) echo "usage: $0 [calibrate|run]"; exit 2;; esac
