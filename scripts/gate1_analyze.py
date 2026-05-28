#!/usr/bin/env python3
"""
gate1_analyze.py — #64 Phase-1 sub-ms-sync ON-DEVICE GATE analysis.

Parses `ShadowBeat` JSON records (and, if present, the #167 COARSE armPhase
log) from a logcat capture and evaluates the Phase-1 -> Phase-2 gate against the
frozen gate-signature numbers (docs/64-sub-ms-sync-changeset.md, Legolas 3629).

EGRESS (src/useMidiBus.ts): per downbeat while the probe is armed, the bus logs
    log.i('ShadowBeat', JSON.stringify({bh,rs,rd,pn,af,gen,vf,vs,rst}))
and nativeLog mirrors info -> Android logcat.
  bh beatHeardNanos | rs rawSkewNs (UNTRIMMED, cumulative-K; slope=DAC drift,
  detrended noise = LAW-FREE floor) | rd residualNs (proportional-trim; as-designed
  law floor) | pn periodNanos (=60e9/bpm) | af atFrame | gen (anchor discontinuity)
  | vf vsyncFrames | vs vsyncSlow (>10ms intervals = ARR demotion) | rst reset beat.

CAPTURE (once the Pixel is back on adb):
    adb logcat -c
    # ... run the bookended 40<->240 sweep (scripts/gate1_sweep.sh) ...
    adb logcat -d -s ShadowBeat:* PendulumArm:* > capture.log
    python3 scripts/gate1_analyze.py capture.log

GATE CRITERIA (on-device-measurable only; PIPELINE is rig-only, NOT here):
  1. CLOCK IDENTITY  — gate-1 one-shot (captured separately; see --note). Not from
     ShadowBeat; this script flags if you didn't supply it.
  2. ACHIEVABILITY FLOOR sub-ms — robust spread (IQR/MAD) of PER-SEGMENT
     local-linear-DETRENDED rawSkew. NEVER global-detrend (curvature would read the
     floor artificially LOW = false PASS). Exclude reset beats from the fit.
  3. SCRUB-TRANSIENT-GONE (head-to-head) — closed-form residual spread stays FLAT
     under BPM scrub while the live #167 PLL (armPhase phaseErr) blows out.

FROZEN NUMBERS: ramp knee ~156 BPM; high-BPM residual floor ~108us; bookend
40<->240 BPM; fingerprint residualNs offset ~ 1/f (proportional, matches declared).
"""
import sys, json, re, argparse, math, statistics as st

SUBMS_NS = 1_000_000.0          # 1 ms — achievability floor must be < this
RAMP_KNEE_BPM = 156.0
HIGH_BPM_FLOOR_US = 108.0
US = 1_000.0                     # ns per microsecond

# ---- robust stats (stdlib only) -------------------------------------------
def _q(xs, p):
    if not xs:
        return float("nan")
    s = sorted(xs)
    if len(s) == 1:
        return s[0]
    i = p * (len(s) - 1)
    lo = int(math.floor(i)); hi = int(math.ceil(i))
    return s[lo] + (s[hi] - s[lo]) * (i - lo)

def iqr(xs):
    return _q(xs, 0.75) - _q(xs, 0.25)

def mad(xs):
    if not xs:
        return float("nan")
    m = st.median(xs)
    return st.median([abs(x - m) for x in xs])

def ols(xs, ys):
    """Least-squares slope, intercept of ys ~ xs. Returns (slope, intercept)."""
    n = len(xs)
    if n < 2:
        return 0.0, (ys[0] if ys else 0.0)
    mx = sum(xs) / n; my = sum(ys) / n
    sxx = sum((x - mx) ** 2 for x in xs)
    if sxx == 0:
        return 0.0, my
    sxy = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
    slope = sxy / sxx
    return slope, my - slope * mx

# ---- parse ----------------------------------------------------------------
SHADOW_RE = re.compile(r"ShadowBeat[^{]*(\{.*\})")
# #167 COARSE armPhase diag — tolerant: any line carrying a phaseErr-ish JSON.
ARM_RE = re.compile(r"(?:armPhase|PendulumArm|phaseErr)[^{]*(\{.*\})", re.I)

def parse(lines):
    beats, arm = [], []
    for ln in lines:
        m = SHADOW_RE.search(ln)
        if m:
            try:
                beats.append(json.loads(m.group(1)))
            except Exception:
                pass
            continue
        m = ARM_RE.search(ln)
        if m:
            try:
                arm.append(json.loads(m.group(1)))
            except Exception:
                pass
    return beats, arm

def bpm_of(rec):
    pn = rec.get("pn") or 0
    return 60e9 / pn if pn else float("nan")

def segment(beats):
    """Group consecutive beats into steady-BPM holds (a sweep step). A bpm jump
    of >1 starts a new segment. Reset beats (rst) break a segment and are dropped
    from the steady analysis."""
    segs, cur, curbpm = [], [], None
    for b in beats:
        if b.get("rst"):
            if cur:
                segs.append((round(curbpm), cur)); cur = []; curbpm = None
            continue
        bpm = bpm_of(b)
        if curbpm is None or abs(bpm - curbpm) <= 1.0:
            cur.append(b); curbpm = bpm if curbpm is None else curbpm
        else:
            if cur:
                segs.append((round(curbpm), cur))
            cur, curbpm = [b], bpm
    if cur:
        segs.append((round(curbpm), cur))
    return segs

def detrended_floor_ns(seg_beats):
    """Per-segment local-linear detrend of rawSkew over beat index; return robust
    spread (IQR & MAD) of the residual = the law-free achievability floor."""
    rs = [b["rs"] for b in seg_beats if "rs" in b]
    if len(rs) < 4:
        return None
    idx = list(range(len(rs)))
    slope, inter = ols(idx, rs)
    resid = [y - (slope * x + inter) for x, y in zip(idx, rs)]
    return {"n": len(rs), "iqr_ns": iqr(resid), "mad_ns": mad(resid),
            "slope_ns_per_beat": slope, "resid_max_ns": max(abs(r) for r in resid)}

# ---- report ---------------------------------------------------------------
def main():
    ap = argparse.ArgumentParser(description="#64 Phase-1 gate analysis")
    ap.add_argument("logfile", nargs="?", help="logcat capture (else stdin)")
    a = ap.parse_args()
    raw = open(a.logfile, encoding="utf-8", errors="replace").read() if a.logfile else sys.stdin.read()
    beats, arm = parse(raw.splitlines())

    print("=" * 72)
    print("#64 Phase-1 GATE ANALYSIS")
    print("=" * 72)
    print(f"parsed: {len(beats)} ShadowBeat records, {len(arm)} armPhase records")
    if not beats:
        print("\nNO ShadowBeat records found. Check: probe armed (metro running on a")
        print("SHADOW_PROBE_ENABLED build), logcat tag 'ShadowBeat', capture not empty.")
        return 2

    resets = sum(1 for b in beats if b.get("rst"))
    segs = segment(beats)
    print(f"segments (steady BPM holds): {len(segs)}   reset beats excluded: {resets}")

    bpms = sorted({bp for bp, _ in segs})
    span = (min(bpms), max(bpms)) if bpms else (0, 0)
    bookended = span[0] <= 45 and span[1] >= 235
    print(f"BPM span: {span[0]}..{span[1]}  bookend(40<->240): "
          f"{'OK' if bookended else 'INSUFFICIENT — fingerprint cannot separate 1/f from flat'}")

    # ---- Criterion 2: achievability floor ----
    print("\n-- Criterion 2: ACHIEVABILITY FLOOR (detrended rawSkew, per-segment) --")
    print(f"{'BPM':>5} {'n':>4} {'floorIQR(us)':>12} {'MAD(us)':>9} "
          f"{'drift(us/beat)':>14} {'resid|max|(us)':>14} {'residMed(us)':>12} {'vSlow%':>7}")
    worst_floor = 0.0
    seg_rows = []
    for bp, bs in segs:
        f = detrended_floor_ns(bs)
        if not f:
            continue
        rd = [b["rd"] for b in bs if "rd" in b]
        rd_med = st.median(rd) if rd else float("nan")
        vf = sum(b.get("vf", 0) for b in bs); vs = sum(b.get("vs", 0) for b in bs)
        vslow_pct = (100.0 * vs / vf) if vf else 0.0
        worst_floor = max(worst_floor, f["iqr_ns"])
        seg_rows.append((bp, f, rd_med, vslow_pct))
        print(f"{bp:>5} {f['n']:>4} {f['iqr_ns']/US:>12.1f} {f['mad_ns']/US:>9.1f} "
              f"{f['slope_ns_per_beat']/US:>14.2f} {f['resid_max_ns']/US:>14.1f} "
              f"{rd_med/US:>12.1f} {vslow_pct:>6.1f}%")
    floor_pass = worst_floor < SUBMS_NS and worst_floor > 0
    print(f"\nworst-segment detrended floor (IQR): {worst_floor/US:.1f} us  "
          f"=> {'SUB-MS PASS' if floor_pass else 'FAIL/NO-DATA'} (threshold 1000 us)")

    # ---- residualNs ramp curve + knee ----
    print("\n-- residualNs floor-vs-BPM (ramp curve; expect knee ~156 BPM) --")
    below = [r for r in seg_rows if r[0] < RAMP_KNEE_BPM]
    above = [r for r in seg_rows if r[0] >= RAMP_KNEE_BPM]
    def med_abs_resid(rows):
        vals = [abs(r[2]) for r in rows if not math.isnan(r[2])]
        return st.median(vals) if vals else float("nan")
    hi_floor = med_abs_resid(above)
    lo_floor = med_abs_resid(below)
    print(f"  >= {RAMP_KNEE_BPM:.0f} BPM: median |residual| = {hi_floor/US:.1f} us "
          f"(expect flat ~{HIGH_BPM_FLOOR_US:.0f} us)")
    print(f"  <  {RAMP_KNEE_BPM:.0f} BPM: median |residual| = {lo_floor/US:.1f} us "
          f"(expect RAMP — larger than high-BPM, cap-limited)")
    ramp_seen = (not math.isnan(lo_floor) and not math.isnan(hi_floor) and lo_floor > hi_floor * 1.5)
    print(f"  ramp present (low >> high): {'YES (as-designed proportional limit)' if ramp_seen else 'no/insufficient'}")

    # ---- fingerprint: residual offset ~ 1/f (proportional) ----
    print("\n-- Fingerprint: residualNs offset vs 1/f (proportional vs integral) --")
    fs = [(60.0 / r[0], abs(r[2])) for r in seg_rows if r[0] and not math.isnan(r[2])]
    if len(fs) >= 3:
        xs = [x for x, _ in fs]; ys = [y for _, y in fs]
        slope, inter = ols(xs, ys)  # offset = slope*(1/f_period?) ...
        # x here = 60/bpm (seconds/beat); residual ~ drift/(GAIN) * x for proportional
        print(f"  fit |residual| ~ {slope/US:.1f} us * (60/BPM) + {inter/US:.1f} us")
        if slope > 0 and slope / US > 5:
            print("  => offset scales with 1/f  => PROPORTIONAL running (matches declared law)")
        else:
            print("  => offset ~flat/near-zero  => INTEGRAL-style — declared-vs-coded MISMATCH (BUG)")
    else:
        print("  insufficient BPM spread for the fingerprint (need the bookended sweep)")

    # ---- Criterion 3: scrub head-to-head ----
    print("\n-- Criterion 3: SCRUB-TRANSIENT-GONE (head-to-head) --")
    if arm:
        def field(d, *names):
            for n in names:
                if n in d:
                    return d[n]
            return None
        arm_err = [abs(field(d, "phaseErrMs", "phaseErr", "errMs") or 0.0) for d in arm]
        arm_err = [e for e in arm_err if e]
        cf_resid_ms = [abs(b.get("rd", 0)) / 1e6 for b in beats if not b.get("rst")]
        if arm_err and cf_resid_ms:
            print(f"  #167 armPhase |phaseErr| during scrub: max {max(arm_err):.1f} ms, "
                  f"p90 {_q(arm_err,0.9):.1f} ms  (expect BLOWOUT +90..+233 ms)")
            print(f"  closed-form |residual|:                 max {max(cf_resid_ms):.3f} ms, "
                  f"p90 {_q(cf_resid_ms,0.9):.3f} ms  (expect FLAT, sub-ms)")
            gone = max(cf_resid_ms) < 1.0 and max(arm_err) > 50.0
            print(f"  => scrub-transient-gone: {'PASS' if gone else 'INCONCLUSIVE — need a real scrub span with both legs'}")
        else:
            print("  armPhase present but no phaseErr field parsed — check the diag tag/format.")
    else:
        print("  NO armPhase records. Capture the #167 COARSE armPhase log (re-armed on")
        print("  BPM scrub) alongside ShadowBeat to run the head-to-head. Criterion 3 PENDING.")

    # ---- verdict ----
    print("\n" + "=" * 72)
    print("GATE VERDICT (honest — only what the data shows):")
    print(f"  1. clock-identity ........ NOT IN THIS CAPTURE (gate-1 one-shot — verify separately)")
    print(f"  2. achievability sub-ms .. {'PASS' if floor_pass else 'NOT SHOWN'}  "
          f"(worst floor {worst_floor/US:.1f} us)")
    print(f"  3. scrub-transient-gone .. {'data present' if arm else 'PENDING (no armPhase capture)'}")
    print("  PIPELINE: rig-only, NOT gated here (cancels out of the closed-form offset).")
    print("=" * 72)
    return 0

if __name__ == "__main__":
    sys.exit(main())
