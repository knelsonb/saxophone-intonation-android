#!/usr/bin/env bash
# avdkit.sh — AVD input/output tooling for BellCurve test + verification.
#
# Wraps adb with the reliability fixes learned the hard way driving the #69
# landscape work:
#   * rotate VERIFIES the display actually rotated (settings.put alone is flaky
#     — auto-rotate resets it, and a tap on the wrong-orientation surface fires
#     an edge-back gesture and backgrounds the app).
#   * shot auto-resizes the screencap (full-res 2400px exceeds the image-read
#     cap in many-image contexts) — emits <name>_s.png ready to read.
#   * tab navigates by NAME, computing coords from the LIVE rotated size
#     (dumpsys cur=, NOT physical wm size) + per-orientation nav-y, clamped away
#     from screen edges so it never trips the edge-back gesture.
#   * launch waits for the resumed activity + a JS-bundle settle.
#
# Target device: $AVD (default emulator-5554 = bc_test pixel_7). For bc_small:
#   AVD=emulator-5558 bash scripts/avdkit.sh ...
#
# Usage:
#   avdkit.sh launch                 # monkey-launch + wait for render
#   avdkit.sh rotate P|L             # force portrait/landscape (verified)
#   avdkit.sh tab tuner|metro|deck|setup
#   avdkit.sh shot NAME [maxpx]      # screencap -> $SHOTDIR/NAME_s.png (<=maxpx)
#   avdkit.sh cap NAME [P|L] [tab]   # rotate + (optional tab) + shot, one shot
#   avdkit.sh tap X Y | swipe X1 Y1 X2 Y2 [dur] | size | rot
set -uo pipefail

AVD="${AVD:-emulator-5554}"
PKG="${PKG:-com.knelsonb.intonationanalyzer}"
SHOTDIR="${SHOTDIR:-/tmp/avdshots}"
mkdir -p "$SHOTDIR"

a() { adb -s "$AVD" "$@"; }

# Current ROTATED size (e.g. 2400x1080 in landscape) — NOT physical wm size.
cur_size() { a shell dumpsys window displays 2>/dev/null | grep -oE 'cur=[0-9]+x[0-9]+' | head -1 | sed 's/cur=//'; }
cur_rot()  { a shell dumpsys window displays 2>/dev/null | grep -oE 'mDisplayRotation=ROTATION_[0-9]+' | head -1 | grep -oE '[0-9]+$'; }

cmd_rotate() {
  local want="${1:-}" target
  case "$want" in P|p|portrait) target=0;; L|l|landscape) target=1;; *) echo "rotate P|L" >&2; return 2;; esac
  a shell settings put system accelerometer_rotation 0 >/dev/null 2>&1
  a shell settings put system user_rotation "$target" >/dev/null 2>&1
  local i sz w h
  for i in 1 2 3 4 5 6 7 8; do
    a shell sleep 0.5 >/dev/null 2>&1
    sz=$(cur_size); w=${sz%x*}; h=${sz#*x}
    if [ "$target" = 1 ] && [ "${w:-0}" -gt "${h:-0}" ]; then echo "landscape $sz"; return 0; fi
    if [ "$target" = 0 ] && [ "${h:-0}" -gt "${w:-0}" ]; then echo "portrait $sz"; return 0; fi
    a shell settings put system user_rotation "$target" >/dev/null 2>&1
  done
  echo "WARN: rotate to $want may not have taken ($(cur_size))" >&2
}

cmd_launch() {
  a shell monkey -p "$PKG" -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1
  local i
  for i in $(seq 1 18); do
    if a shell dumpsys activity activities 2>/dev/null | grep -q "ResumedActivity.*$PKG"; then
      a shell sleep 3 >/dev/null 2>&1   # JS bundle settle past the splash
      echo "launched (resumed)"; return 0
    fi
    a shell sleep 0.4 >/dev/null 2>&1
  done
  echo "WARN: app did not reach resumed state" >&2
}

cmd_shot() {
  local name="${1:-shot}" max="${2:-1500}" raw="$SHOTDIR/${1:-shot}.png" out="$SHOTDIR/${1:-shot}_s.png"
  a exec-out screencap -p > "$raw" 2>/dev/null
  python3 - "$raw" "$out" "$max" <<'PY'
import sys
from PIL import Image
src, dst, mx = sys.argv[1], sys.argv[2], int(sys.argv[3])
im = Image.open(src); im.thumbnail((mx, mx)); im.save(dst)
print(dst, im.size)
PY
}

cmd_tab() {
  local name="${1:-}" idx
  case "$name" in
    tuner|TUNER) idx=0;; metro|METRO) idx=1;; deck|DECK) idx=2;; setup|SETUP) idx=3;;
    *) echo "tab tuner|metro|deck|setup" >&2; return 2;;
  esac
  local sz w h ny x
  sz=$(cur_size); w=${sz%x*}; h=${sz#*x}
  # per-orientation nav-y (landscape nav sits higher in the content area)
  if [ "$w" -gt "$h" ]; then ny=$(( h * 87 / 100 )); else ny=$(( h * 94 / 100 )); fi
  x=$(( w * (idx*2+1) / 8 ))                 # even-spaced tab centre
  [ "$x" -lt 150 ] && x=150                   # clamp off the edges so we never
  [ "$x" -gt $((w-150)) ] && x=$((w-150))     # trip the edge-back gesture
  a shell input tap "$x" "$ny"
  a shell sleep 1 >/dev/null 2>&1
  echo "tab $name @ $x,$ny  (size $sz)"
}

cmd_cap() {  # cap NAME [P|L] [tab]
  local name="${1:-shot}" orient="${2:-}" tab="${3:-}"
  [ -n "$orient" ] && cmd_rotate "$orient" >&2
  [ -n "$tab" ] && cmd_tab "$tab" >&2
  cmd_shot "$name"
}

case "${1:-}" in
  launch) shift; cmd_launch "$@";;
  rotate) shift; cmd_rotate "$@";;
  tab)    shift; cmd_tab "$@";;
  shot)   shift; cmd_shot "$@";;
  cap)    shift; cmd_cap "$@";;
  tap)    shift; a shell input tap "$1" "$2";;
  swipe)  shift; a shell input swipe "$1" "$2" "$3" "$4" "${5:-300}";;
  size)   cur_size;;
  rot)    cur_rot;;
  *) echo "usage: avdkit.sh {launch|rotate P|L|tab NAME|shot NAME [maxpx]|cap NAME [P|L] [tab]|tap X Y|swipe ...|size|rot}" >&2; exit 2;;
esac
