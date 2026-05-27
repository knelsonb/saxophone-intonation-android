#!/usr/bin/env python3
"""
Generate the BELLCURVE app logo assets.

Concept: a Gaussian bell curve with a thin tuner-needle pivoting from the
baseline through the curve's interior, sweeping a few degrees off centre.
The bell curve = the app's statistical mode (intonation buckets per note).
The needle = the live tuner. Together they say "this app does both."

Outputs (overwrites in place):
  assets/icon.png                        1024×1024 RGB   — iOS / launcher
  assets/android-icon-foreground.png      512×512  RGBA  — foreground layer
  assets/android-icon-background.png      512×512  RGBA  — solid bg layer
  assets/android-icon-monochrome.png      432×432  RGBA  — themed-icon mask
  assets/favicon.png                       48×48   RGBA  — web
  assets/splash-icon.png                 1024×1024 RGBA  — splash centerpiece
"""

from math import exp, sin, cos, radians
from pathlib import Path
from PIL import Image, ImageDraw, ImageFilter

# Brand palette — sourced from src/theme.ts DARK_PALETTE. Two-tone needle:
#   amber curve  = the data (statistical distribution per note)
#   amber pivot  = anchor in the brand colour, ties back to the curve
#   white needle + tip = the live measurement line, eye-catch
COLOR_BG     = (7, 8, 11, 255)       # #07080b — near-black bg
COLOR_CURVE  = (227, 196, 122, 255)  # #e3c47a — amber, brand accent
COLOR_NEEDLE = (255, 255, 255, 255)  # #ffffff — high-contrast tuner needle
COLOR_PIVOT  = (227, 196, 122, 255)  # amber, matches the curve
COLOR_TIP    = (255, 255, 255, 255)  # white, matches the needle line
COLOR_SCALE  = (90, 98, 109, 255)    # #5a626d — dim baseline ticks
COLOR_TINT   = (227, 196, 122, 40)   # amber fill under the curve, low alpha

ASSETS = Path(__file__).resolve().parents[1] / 'assets'


def gaussian(x: float, mu: float, sigma: float) -> float:
    """Standard normal-shape, peak normalized to 1."""
    z = (x - mu) / sigma
    return exp(-0.5 * z * z)


def draw_logo(
    size: int,
    *,
    with_bg: bool = True,
    fg_only: bool = False,
    monochrome: bool = False,
) -> Image.Image:
    """Render the logo at `size`×`size`. Geometry scales linearly with size."""
    if monochrome:
        # Single-channel artwork for themed-icon masking; the OS recolours it.
        # Pivot stays at 0 so the "recessed" hole effect carries over when
        # the OS paints the icon in a single hue.
        img = Image.new('L', (size, size), 0)
        draw = ImageDraw.Draw(img)
        bg, curve, needle, pivot, tip, scale = 0, 220, 255, 0, 255, 90
    else:
        img = Image.new('RGBA', (size, size), COLOR_BG if with_bg else (0, 0, 0, 0))
        draw = ImageDraw.Draw(img, 'RGBA')
        bg, curve, needle, pivot, tip, scale = (
            COLOR_BG, COLOR_CURVE, COLOR_NEEDLE, COLOR_PIVOT, COLOR_TIP, COLOR_SCALE
        )

    # Layout in normalized [0,1]² then scale up. Safe zone for adaptive icons
    # is the central 66% — keep the curve well inside that.
    cx       = size * 0.5
    baseline = size * 0.72
    peak_y   = size * 0.24
    sigma    = size * 0.14
    x_lo     = size * 0.10
    x_hi     = size * 0.90

    # --- baseline (tuner scale) ----------------------------------------------
    bl_w = max(2, size // 200)
    draw.line(
        [(x_lo, baseline), (x_hi, baseline)],
        fill=scale,
        width=bl_w,
    )
    # Tick marks at -25, 0, +25 (the cents arc echo).
    tick_h = size * 0.025
    tick_w = max(2, size // 220)
    for frac in (0.35, 0.5, 0.65):
        tx = x_lo + (x_hi - x_lo) * frac
        draw.line(
            [(tx, baseline - tick_h * 0.4), (tx, baseline + tick_h * 0.6)],
            fill=scale,
            width=tick_w,
        )
    # Centre tick taller.
    draw.line(
        [(cx, baseline - tick_h * 0.9), (cx, baseline + tick_h * 0.6)],
        fill=scale,
        width=tick_w + 1,
    )

    # --- bell curve ----------------------------------------------------------
    # Sample densely enough that line segments read as a smooth curve at any
    # output size, even down to 48px (favicon).
    samples = max(96, size // 6)
    pts = []
    for i in range(samples + 1):
        t = i / samples
        x = x_lo + (x_hi - x_lo) * t
        y = baseline - (baseline - peak_y) * gaussian(x, cx, sigma)
        pts.append((x, y))

    # Faint amber fill under the curve — only on full-colour outputs.
    if not monochrome:
        fill_pts = pts + [(x_hi, baseline), (x_lo, baseline)]
        draw.polygon(fill_pts, fill=COLOR_TINT)

    # Curve stroke — 20% thicker than the original (was size/64).
    curve_w = max(4, size // 53)
    draw.line(pts, fill=curve, width=curve_w, joint='curve')

    # --- needle --------------------------------------------------------------
    # Pivot at the baseline centre. Tip lifted ~ 9° off vertical to the right
    # (clockwise), reading as "slightly sharp" — a tuner cue.
    angle_deg = 9.0
    needle_len = (baseline - peak_y) * 1.08  # extends just past the curve peak
    rad = radians(angle_deg)
    tip_x = cx + needle_len * sin(rad)
    tip_y = baseline - needle_len * cos(rad)
    needle_w = max(3, size // 110)
    draw.line(
        [(cx, baseline), (tip_x, tip_y)],
        fill=needle,
        width=needle_w,
    )
    # Pivot disc — small, amber, sits at the baseline as the curve's anchor.
    piv_r = max(6, size // 48)
    draw.ellipse(
        (cx - piv_r, baseline - piv_r, cx + piv_r, baseline + piv_r),
        fill=pivot,
        outline=None,
    )
    # Tip dot — white, slightly larger than the needle so it reads as a target.
    tip_r = max(4, size // 70)
    draw.ellipse(
        (tip_x - tip_r, tip_y - tip_r, tip_x + tip_r, tip_y + tip_r),
        fill=tip,
        outline=None,
    )

    return img


def save_rgb(img: Image.Image, path: Path) -> None:
    """Flatten to RGB for the top-level icon (Apple wants no alpha)."""
    bg = Image.new('RGB', img.size, COLOR_BG[:3])
    bg.paste(img, mask=img.split()[3] if img.mode == 'RGBA' else None)
    bg.save(path, 'PNG')


def main() -> None:
    # 1024×1024 RGB — iOS launcher icon. Cannot have alpha per App Store rules.
    icon_1024 = draw_logo(1024, with_bg=True)
    save_rgb(icon_1024, ASSETS / 'icon.png')

    # 1024×1024 RGBA — splash screen centerpiece (transparent surround so
    # expo-splash-screen's background colour shows through).
    splash = draw_logo(1024, with_bg=False)
    splash.save(ASSETS / 'splash-icon.png', 'PNG')

    # 512×512 adaptive foreground (RGBA, no bg — bg is a separate layer).
    fg = draw_logo(512, with_bg=False)
    fg.save(ASSETS / 'android-icon-foreground.png', 'PNG')

    # 512×512 adaptive background (RGBA, solid near-black).
    bg = Image.new('RGBA', (512, 512), COLOR_BG)
    bg.save(ASSETS / 'android-icon-background.png', 'PNG')

    # 432×432 monochrome (grayscale on RGBA — Android themes recolour it).
    mono = draw_logo(432, with_bg=False, monochrome=True)
    # Convert L → RGBA where alpha == L so the OS gets a proper mask.
    mono_rgba = Image.new('RGBA', mono.size, (0, 0, 0, 0))
    for y in range(mono.size[1]):
        for x in range(mono.size[0]):
            v = mono.getpixel((x, y))
            if v > 0:
                mono_rgba.putpixel((x, y), (255, 255, 255, v))
    mono_rgba.save(ASSETS / 'android-icon-monochrome.png', 'PNG')

    # 48×48 favicon (web). PIL antialiases line-draw weakly at tiny sizes;
    # render at 4× then downscale with LANCZOS for crisp results.
    big = draw_logo(192, with_bg=True)
    fav = big.resize((48, 48), Image.Resampling.LANCZOS)
    fav.save(ASSETS / 'favicon.png', 'PNG')

    print('icon assets generated')


if __name__ == '__main__':
    main()
