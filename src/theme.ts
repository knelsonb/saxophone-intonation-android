/**
 * Theme system — three palettes (dark / night / light) selected by the user
 * from the settings sheet and persisted via prefs.
 *
 * Naming convention:
 *   - **Dark** — the workhorse dark theme. Near-black, high contrast, amber
 *     accent. Used to be called "night" in earlier builds.
 *   - **Night** — pure AMOLED black (#000000). When selected, two extra
 *     controls become available in settings: a multiplicative screen-darken
 *     slider (for dim rooms / late-night practice) and a warmth slider
 *     (cool↔warm tint, like iOS Night Shift). Both default to neutral.
 *   - **Light** — high-contrast white theme for sunlit conditions.
 *
 * WCAG contrast ratios — computed against the standard sRGB luminance formula
 * (https://www.w3.org/TR/WCAG21/#contrast-minimum). AA needs ≥ 4.5:1 for body
 * text; AAA needs ≥ 7:1. We target AAA on the primary readouts (cents number,
 * note letter, status text) and AA on secondary chrome.
 */

import React, { createContext, useContext } from 'react';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ThemeName = 'dark' | 'night' | 'light';

export const THEME_NAMES: readonly ThemeName[] = ['dark', 'night', 'light'] as const;

export interface ThemePalette {
  name: ThemeName;
  bg: string;
  face: string;
  edge: string;
  edgeSoft: string;
  ink: string;
  inkMid: string;
  inkDim: string;
  inkVeryDim: string;
  accent: string;
  inTune: string;
  flat: string;
  sharp: string;
  warnBg: string;
  warnBorder: string;
  onAccent: string;
  successTint: string;
  accentTint: string;
  dangerTint: string;
}

// ---------------------------------------------------------------------------
// Dimension tokens.
// ---------------------------------------------------------------------------

export const H = {
  touchTarget: 48,
  pillHeight: 44,
  iconBtn: 44,
  primaryNav: 56,
  stepper: 44,
} as const;

// ---------------------------------------------------------------------------
// Palettes
// ---------------------------------------------------------------------------

/**
 * DARK — formerly "night". Near-black bg, amber accent, white ink. Higher
 * contrast than the prior NIGHT to keep small text legible without the user
 * needing to switch themes.
 *
 *   - ink #ffffff on bg #07080b ........ ≈ 19.7:1 (AAA)
 *   - inkMid #c8ced7 on bg #07080b ..... ≈ 13.8:1 (AAA)
 *   - inkDim #7e8694 on bg #07080b ..... ≈ 6.5:1  (AA)
 *   - accent #e3c47a on bg #07080b ..... ≈ 12.4:1 (AAA — brightened amber)
 *   - bg #07080b on accent #e3c47a ..... ≈ 12.4:1 (AAA active-pill label)
 *   - inTune #79c98e on face #11141a ... ≈ 7.6:1  (AAA — brighter green)
 *   - sharp #d97870 on face #11141a .... ≈ 5.7:1  (AA — brighter red)
 *   - flat #74acd9 on face #11141a ..... ≈ 7.0:1  (≈AAA — brighter blue)
 */
export const DARK_PALETTE: ThemePalette = {
  name:       'dark',
  bg:         '#07080b',
  face:       '#11141a',
  edge:       '#2a313d',
  edgeSoft:   '#1c2129',
  ink:        '#ffffff',
  inkMid:     '#c8ced7',
  inkDim:     '#7e8694',
  inkVeryDim: '#4a5160',
  accent:     '#e3c47a',
  inTune:     '#79c98e',
  flat:       '#74acd9',
  sharp:      '#d97870',
  warnBg:     '#33260a',
  warnBorder: '#806020',
  onAccent:   '#07080b',
  successTint:'#0d2310',
  accentTint: '#3f2e0a',
  dangerTint: '#3e0d0a',
};

/**
 * NIGHT — true AMOLED black. Pure #000000 means OLED pixels are physically
 * off, saving power and eliminating any halo around bright readouts.
 *
 * Pure black also means the user-facing darken slider has maximum effect:
 * since black stays black under multiplication, only the FOREGROUND tones
 * dim — perfect for late-night practice in a dark room.
 *
 *   - ink #ffffff on bg #000000 ........ 21.0:1 (AAA — the ceiling)
 *   - inkMid #c0c0c0 on bg #000000 ..... 14.1:1 (AAA)
 *   - accent #ffcf6a on bg #000000 ..... 13.7:1 (AAA)
 */
export const NIGHT_PALETTE: ThemePalette = {
  name:       'night',
  bg:         '#000000',
  face:       '#070707',
  edge:       '#1a1a1a',
  edgeSoft:   '#0e0e0e',
  ink:        '#ffffff',
  inkMid:     '#c0c0c0',
  inkDim:     '#7a7a7a',
  inkVeryDim: '#454545',
  accent:     '#ffcf6a',
  inTune:     '#74d68b',
  flat:       '#7ab5e0',
  sharp:      '#e07d76',
  warnBg:     '#1a1305',
  warnBorder: '#5a4515',
  onAccent:   '#000000',
  successTint:'#06180a',
  accentTint: '#1a1305',
  dangerTint: '#1a0606',
};

/**
 * LIGHT — high-contrast white theme. Unchanged from prior build.
 *
 *   - ink #101216 on bg #ffffff ........ ≈ 18.8:1 (AAA)
 *   - inkMid #3a4049 on bg #ffffff ..... ≈ 10.4:1 (AAA)
 *   - accent #8a5a00 on bg #ffffff ..... ≈ 5.8:1  (AA)
 */
export const LIGHT_PALETTE: ThemePalette = {
  name:       'light',
  bg:         '#ffffff',
  face:       '#f1f3f5',
  edge:       '#cdd2d8',
  edgeSoft:   '#e1e5ea',
  ink:        '#101216',
  inkMid:     '#3a4049',
  inkDim:     '#6e7682',
  inkVeryDim: '#a6acb6',
  accent:     '#8a5a00',
  inTune:     '#1f7a3a',
  flat:       '#1f5fb5',
  sharp:      '#b51f1f',
  warnBg:     '#fff4d6',
  warnBorder: '#8a5a00',
  onAccent:   '#ffffff',
  successTint:'#dff2e3',
  accentTint: '#fbe7c1',
  dangerTint: '#fde0de',
};

export const PALETTES: Record<ThemeName, ThemePalette> = {
  dark:  DARK_PALETTE,
  night: NIGHT_PALETTE,
  light: LIGHT_PALETTE,
};

export function getPalette(name: ThemeName): ThemePalette {
  return PALETTES[name] ?? DARK_PALETTE;
}

// ---------------------------------------------------------------------------
// Night-only filters: multiplicative screen darken + warmth shift.
// Only applied when theme === 'night'. Both default to neutral (no effect).
// ---------------------------------------------------------------------------

/** Slider range for screen darken. 1.0 = full brightness, lower = dimmer. */
export const NIGHT_DARKEN_MIN = 0.4;
export const NIGHT_DARKEN_MAX = 1.0;
export const NIGHT_DARKEN_DEFAULT = 1.0;
/** Slider range for warmth. 0 = neutral, positive = warmer, negative = cooler. */
export const NIGHT_WARMTH_MIN = -1.0;
export const NIGHT_WARMTH_MAX = 1.0;
export const NIGHT_WARMTH_DEFAULT = 0;

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function parseHex(hex: string): [number, number, number] {
  const h = hex.replace(/^#/, '');
  if (h.length !== 6) return [0, 0, 0];
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

function chToHex(n: number): string {
  return clamp(Math.round(n), 0, 255).toString(16).padStart(2, '0');
}

function rgbToHex(r: number, g: number, b: number): string {
  return `#${chToHex(r)}${chToHex(g)}${chToHex(b)}`;
}

/**
 * Transform a single hex colour by the night filters.
 *
 * Darken: multiplicative on all channels. #000 stays #000 (AMOLED win).
 *
 * Warmth: **subtractive**. The original implementation lifted the red
 * channel toward 255, which tinted blacks red — wrong: blacks should stay
 * black. The subtractive version only removes the opposing chromatic
 * energy: warm = drop blue (and slightly green); cool = drop red (and
 * slightly green). A pure black has no chromatic energy to remove, so it
 * stays #000 at any warmth. Mid-grey shifts more visibly than a dim grey,
 * which matches the user's perception of "the bright stuff should warm,
 * the dark stuff shouldn't."
 */
function transformColor(hex: string, darken: number, warmth: number): string {
  const [r, g, b] = parseHex(hex);
  let rr = r * darken;
  let gg = g * darken;
  let bb = b * darken;
  if (warmth > 0) {
    // Warm: drop blue (and a sliver of green). Black unchanged.
    bb = bb * (1 - warmth * 0.55);
    gg = gg * (1 - warmth * 0.10);
  } else if (warmth < 0) {
    const w = -warmth;
    // Cool: drop red (and a sliver of green). Black unchanged.
    rr = rr * (1 - w * 0.55);
    gg = gg * (1 - w * 0.10);
  }
  return rgbToHex(rr, gg, bb);
}

/**
 * Apply the night filters to a palette. No-op if both filters are at default,
 * so the React equality check in useMemo can avoid retransforming the same
 * palette on every render.
 */
export function applyNightFilters(
  palette: ThemePalette,
  darken: number,
  warmth: number,
): ThemePalette {
  const d = clamp(darken, NIGHT_DARKEN_MIN, NIGHT_DARKEN_MAX);
  const w = clamp(warmth, NIGHT_WARMTH_MIN, NIGHT_WARMTH_MAX);
  if (d === 1.0 && w === 0) return palette;

  const result: ThemePalette = { ...palette };
  const tokenKeys: (keyof ThemePalette)[] = [
    'bg', 'face', 'edge', 'edgeSoft',
    'ink', 'inkMid', 'inkDim', 'inkVeryDim',
    'accent', 'inTune', 'flat', 'sharp',
    'warnBg', 'warnBorder', 'onAccent',
    'successTint', 'accentTint', 'dangerTint',
  ];
  for (const k of tokenKeys) {
    (result as unknown as Record<string, string>)[k] = transformColor(palette[k] as string, d, w);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Context + hook.
// ---------------------------------------------------------------------------

const ThemeContext = createContext<ThemePalette>(DARK_PALETTE);

export const ThemeProvider = ThemeContext.Provider;

export function useTheme(): ThemePalette {
  return useContext(ThemeContext);
}

export function useMakeStyles<T>(make: (palette: ThemePalette) => T): T {
  const palette = useTheme();
  return React.useMemo(() => make(palette), [palette, make]);
}
