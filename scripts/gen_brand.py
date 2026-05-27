#!/usr/bin/env python3
"""
BELLCURVE brand lockup — logo + wordmark composition.

Font choice: **Ubuntu Bold** — geometric enough for a precision instrument
app, but with humanist warmth (notice the subtle cuts on the B, C, U). The
wide tracking pushes it past "default tech wordmark" into something with
intent. Vertical stems echo the tuner-needle metaphor.

Outputs:
  assets/brand-mockup.png  2400×1600 — horizontal + vertical lockups
"""

from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

from gen_icon import draw_logo, COLOR_BG, COLOR_CURVE, COLOR_NEEDLE

ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / 'assets'
FONT_BOLD = Path('/usr/share/fonts/truetype/ubuntu/Ubuntu-B.ttf')
FONT_MED  = Path('/usr/share/fonts/truetype/ubuntu/Ubuntu-M.ttf')
FONT_REG  = Path('/usr/share/fonts/truetype/ubuntu/Ubuntu-R.ttf')


def draw_wordmark(
    canvas: Image.Image,
    text: str,
    x_center: int,
    y_baseline: int,
    *,
    font_size: int,
    tracking: int,
    fill: tuple[int, int, int, int],
    font_path: Path = FONT_BOLD,
) -> tuple[int, int]:
    """Draw `text` with explicit per-glyph spacing. Returns (width, height)."""
    font = ImageFont.truetype(str(font_path), size=font_size)
    draw = ImageDraw.Draw(canvas, 'RGBA')

    # Pre-measure each glyph so we can centre the run on x_center.
    glyph_widths = []
    for ch in text:
        bbox = draw.textbbox((0, 0), ch, font=font)
        glyph_widths.append(bbox[2] - bbox[0])
    total_w = sum(glyph_widths) + tracking * (len(text) - 1)

    # Use the font's ascent for vertical centering, not bbox top
    # (bbox top depends on the glyph's actual ink, which jitters between
    # letters). Ascent gives a stable baseline.
    ascent, descent = font.getmetrics()
    bbox_top = y_baseline - ascent

    x = x_center - total_w // 2
    for ch, w in zip(text, glyph_widths):
        draw.text((x, bbox_top), ch, font=font, fill=fill)
        x += w + tracking
    return (total_w, ascent + descent)


def main() -> None:
    W, H = 2400, 1600
    canvas = Image.new('RGBA', (W, H), COLOR_BG)
    draw = ImageDraw.Draw(canvas, 'RGBA')

    # Generate two logo sizes (foreground only, no background).
    logo_lg = draw_logo(560, with_bg=False)
    logo_md = draw_logo(380, with_bg=False)
    logo_sm = draw_logo(140, with_bg=False)

    # --- Horizontal lockup (top half) ---------------------------------------
    # Icon on the left, wordmark centred to icon's vertical midline.
    hl_y = 380
    icon_x = 240
    canvas.alpha_composite(logo_lg, (icon_x, hl_y - 280))

    # Wordmark — Ubuntu Bold, generous tracking. Sits to the right of the icon.
    wm_text = 'BELLCURVE'
    wm_font_size = 200
    wm_tracking = 36
    wm_x_center = icon_x + 560 + 60 + 700  # icon + gap + centre of wordmark area
    draw_wordmark(
        canvas,
        wm_text,
        x_center=wm_x_center,
        y_baseline=hl_y,
        font_size=wm_font_size,
        tracking=wm_tracking,
        fill=COLOR_NEEDLE,  # white
    )

    # Tagline beneath the wordmark — small, amber, regular weight.
    tagline_font = ImageFont.truetype(str(FONT_REG), size=44)
    tagline = 'play to the curve.'
    bbox = draw.textbbox((0, 0), tagline, font=tagline_font)
    tag_w = bbox[2] - bbox[0]
    draw.text(
        (wm_x_center - tag_w // 2, hl_y + 50),
        tagline,
        font=tagline_font,
        fill=COLOR_CURVE,
    )

    # Divider — thin amber line between the two lockups.
    div_y = 880
    draw.line(
        [(W * 0.18, div_y), (W * 0.82, div_y)],
        fill=(*COLOR_CURVE[:3], 60),
        width=2,
    )

    # --- Vertical lockup (bottom half) --------------------------------------
    # Icon centred over wordmark.
    vl_icon_x = (W - 380) // 2
    vl_icon_y = 980
    canvas.alpha_composite(logo_md, (vl_icon_x, vl_icon_y))

    draw_wordmark(
        canvas,
        'BELLCURVE',
        x_center=W // 2,
        y_baseline=vl_icon_y + 380 + 130,
        font_size=132,
        tracking=24,
        fill=COLOR_NEEDLE,
    )

    # --- Caption rows at top and bottom edges -------------------------------
    cap_font = ImageFont.truetype(str(FONT_MED), size=28)
    draw.text(
        (W * 0.08, 60),
        'BELLCURVE — brand lockup',
        font=cap_font,
        fill=(160, 168, 180, 255),
    )
    draw.text(
        (W * 0.08, H - 100),
        'wordmark: Ubuntu Bold · tracking +200/em · primary white · accent amber',
        font=cap_font,
        fill=(120, 128, 140, 255),
    )

    # --- Small-size sample (favicon-style) in the corner --------------------
    canvas.alpha_composite(logo_sm, (W - 140 - 80, H - 140 - 80))
    draw.text(
        (W - 200 - 80, H - 60),
        '@ favicon size (140 px)',
        font=cap_font,
        fill=(120, 128, 140, 255),
    )

    out = ASSETS / 'brand-mockup.png'
    canvas.convert('RGB').save(out, 'PNG')
    print(f'brand mockup written to {out}')


if __name__ == '__main__':
    main()
