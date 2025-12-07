import { writable } from "svelte/store";
import { Blend, Hct, SchemeTonalSpot, Variant } from "@ktibow/material-color-utilities-nightly";
import { genCSS } from "$lib/misc/utils";

// Primary brand colors pulled from the favicon to keep the UI on-brand and MD3-consistent.
export const faviconPalette = [
  0xf2e9e1, // ivory frame
  0xea4335, // Gmail red
  0xfbbc05, // sunshine yellow
  0x1a73e8, // link blue
  0x34a853, // success green
  0xf7f2ec, // envelope fill
];

/**
 * Harmonize the favicon palette into a single seed color with healthy chroma so the
 * generated MD3 scheme remains vibrant and predictable instead of feeling random.
 */
export const deriveFaviconSeed = (palette: number[] = faviconPalette) => {
  const vivid = palette.filter((c) => typeof c === "number" && c > 0);
  // Default to Gmail red if anything looks off.
  const base = vivid.find((c) => c === 0xea4335) ?? vivid[1] ?? vivid[0] ?? 0xea4335;

  // Keep the Gmail hue exact, but ensure chroma stays lively so accents don't wash out.
  const hct = Hct.fromInt(base);
  const tone = 55; // Comfortable mid-tone for surfaces and accents
  const chroma = Math.max(hct.chroma, 60);

  return Hct.from(hct.hue, chroma, tone).toInt();
};

const seed = deriveFaviconSeed();
const contrast = 0; // Keep default contrast
const initialVariant = Variant.TONAL_SPOT;
const light = new (SchemeTonalSpot as any)(Hct.fromInt(seed), false, contrast, initialVariant);
const dark = new (SchemeTonalSpot as any)(Hct.fromInt(seed), true, contrast, initialVariant);

// Keep Gmail-like paper surfaces: crisp white background and gentle greys for containers.
const lightSurfaceOverrides = `
@media (prefers-color-scheme: light) {
  :root, ::backdrop {
    --m3-scheme-background: 255 255 255;
    --m3-scheme-surface: 255 255 255;
    --m3-scheme-surface-container-lowest: 255 255 255;
    --m3-scheme-surface-container-low: 252 252 252;
    --m3-scheme-surface-container: 247 247 247;
    --m3-scheme-surface-container-high: 244 244 244;
    --m3-scheme-surface-container-highest: 240 240 240;
    --m3-scheme-surface-variant: 241 243 244;
    --m3-scheme-on-background: 32 33 36;
    --m3-scheme-on-surface: 32 33 36;
    --m3-scheme-outline: 218 220 224;
    --m3-scheme-outline-variant: 232 234 237;
  }
}
`;

const css = `${genCSS(light, dark)}
${lightSurfaceOverrides}`;

export const styling = writable(css);
