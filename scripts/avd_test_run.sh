#!/usr/bin/env bash
# avd_test_run.sh — Tier-A test run for the accuracy/precision plan.
#
# ALWAYS runs the off-device regression (no device needed). Runs the on-AVD
# functional/stability/layout suite ONLY if the AVD is bootable (needs KVM access
# on /dev/kvm). Writes a per-run report dir + appends docs/test-runs/LEDGER.md.
#
#   ./avd_test_run.sh [run-id]      run-id defaults to today (pass an arg in cron)
#
# Untested until first real AVD boot (KVM was blocked at authoring) — refine on run 1.
set -uo pipefail
REPO=/home/repro/code/bellcurve
SDK=/home/repro/android
EMU="$SDK/emulator/emulator"; ADB="$SDK/platform-tools/adb"
AVD=bc_test; PKG=com.knelsonb.intonationanalyzer
APK="$REPO/android/app/build/outputs/apk/release/app-release.apk"
SERIAL=emulator-5554
RUNID="${1:-today}"
OUT="$REPO/docs/test-runs/$RUNID"; mkdir -p "$OUT"
LEDGER="$REPO/docs/test-runs/LEDGER.md"
log(){ printf '[avd-run %s] %s\n' "$RUNID" "$*"; }
row(){ printf '| %s | %s | %s | %s | %s |\n' "$RUNID" "$1" "$2" "$3" "$4" >> "$LEDGER"; }

# ---- 1. off-device regression (always) ----
log "off-device regression"
cd "$REPO"
{ echo "--- tsc ---"; npx tsc --noEmit 2>&1; echo "tsc_rc=$?";
  echo "--- npm test ---"; CI=true npm test 2>&1; echo "test_rc=$?"; } > "$OUT/tierA-regression.log" 2>&1
if grep -q "tsc_rc=0" "$OUT/tierA-regression.log" && grep -q "test_rc=0" "$OUT/tierA-regression.log" && ! grep -qE "error TS[0-9]" "$OUT/tierA-regression.log"; then
  row "A/off" "regression" "GREEN" "tsc+legacy+jest clean"; log "regression GREEN"
else
  row "A/off" "regression" "RED" "see $OUT/tierA-regression.log"; log "regression RED"
fi

# ---- 2. AVD tier (needs KVM) ----
if ! { [ -r /dev/kvm ] && [ -w /dev/kvm ]; }; then
  row "A/AVD" "functional" "BLOCKED" "no /dev/kvm access (chmod 666 /dev/kvm or kvm group)"
  log "KVM blocked — AVD tier skipped"; exit 0
fi

if ! "$ADB" devices | grep -q "^$SERIAL"; then
  log "booting AVD $AVD headless"
  nohup "$EMU" -avd "$AVD" -no-window -no-audio -no-boot-anim -gpu swiftshader_indirect -no-snapshot \
    > "$OUT/emulator.log" 2>&1 &
  timeout 180 "$ADB" -s "$SERIAL" wait-for-device || { row "A/AVD" "boot" "RED" "wait-for-device timeout (emulator failed to start)"; log "wait-for-device timeout"; exit 0; }
  log "waiting for boot_completed"
  booted=0
  for _ in $(seq 1 150); do
    [ "$("$ADB" -s "$SERIAL" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ] && { booted=1; break; }
    sleep 2
  done
  [ "$booted" = 1 ] || { row "A/AVD" "boot" "RED" "boot_completed timeout (see emulator.log)"; log "boot timeout"; exit 0; }
fi
log "AVD up: $SERIAL"

# install current APK
"$ADB" -s "$SERIAL" install -r "$APK" > "$OUT/install.log" 2>&1 \
  && row "A/AVD" "install" "GREEN" "apk installed" \
  || { row "A/AVD" "install" "RED" "see install.log"; exit 0; }

# smoke-launch + crash check
"$ADB" -s "$SERIAL" shell logcat -c; "$ADB" -s "$SERIAL" shell logcat -c -b crash 2>/dev/null
"$ADB" -s "$SERIAL" shell monkey -p "$PKG" -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1
sleep 6
"$ADB" -s "$SERIAL" shell "logcat -d -b crash | tail -60" > "$OUT/crash.log" 2>&1
PKG_RE="${PKG//./\\.}"
if [ -s "$OUT/crash.log" ] && grep -qE "FATAL EXCEPTION.*$PKG_RE|$PKG_RE" "$OUT/crash.log"; then
  row "A/AVD" "launch-no-crash" "RED" "crash in crash.log"
else
  row "A/AVD" "launch-no-crash" "GREEN" "no crash on launch"
fi

# stability: meminfo sample over a short session
"$ADB" -s "$SERIAL" shell dumpsys meminfo "$PKG" > "$OUT/meminfo-start.txt" 2>&1
sleep 30
"$ADB" -s "$SERIAL" shell dumpsys meminfo "$PKG" > "$OUT/meminfo-30s.txt" 2>&1
row "A/AVD" "stability(meminfo)" "INFO" "see meminfo-start/30s.txt (compare TOTAL PSS for growth)"

# layout screencaps (portrait + landscape) for manual review (UI correctness needs eyes)
"$ADB" -s "$SERIAL" shell settings put system accelerometer_rotation 0 >/dev/null 2>&1
"$ADB" -s "$SERIAL" shell content insert --uri content://settings/system --bind name:s:user_rotation --bind value:i:0 >/dev/null 2>&1
"$ADB" -s "$SERIAL" exec-out screencap -p > "$OUT/avd-portrait.png" 2>/dev/null
"$ADB" -s "$SERIAL" shell content insert --uri content://settings/system --bind name:s:user_rotation --bind value:i:1 >/dev/null 2>&1
sleep 2
"$ADB" -s "$SERIAL" exec-out screencap -p > "$OUT/avd-landscape.png" 2>/dev/null
row "A/AVD" "layout-capture" "INFO" "avd-portrait/landscape.png — manual layout review (#67/tab-fit)"
log "Tier-A AVD run done -> $OUT"
