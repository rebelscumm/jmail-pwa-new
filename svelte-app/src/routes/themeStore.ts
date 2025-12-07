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
  if (!vivid.length) return Hct.fromInt(0xea4335).toInt();

  const harmonized = vivid.reduce((acc, color, idx) => {
    if (idx === 0) return color;
    // Pull each brand hue toward the base to keep the resulting scheme cohesive.
    return Blend.harmonize(acc, color);
  }, vivid[0]);

  const hct = Hct.fromInt(harmonized);
  const tone = 55; // Comfortable mid-tone for surfaces and accents
  const chroma = Math.max(hct.chroma, 56); // Ensure enough saturation to avoid a muddy palette

  return Hct.from(hct.hue, chroma, tone).toInt();
};

const seed = deriveFaviconSeed();
const contrast = 0; // Keep default contrast
const initialVariant = Variant.CONTENT;
const light = new (SchemeTonalSpot as any)(Hct.fromInt(seed), false, contrast, initialVariant);
const dark = new (SchemeTonalSpot as any)(Hct.fromInt(seed), true, contrast, initialVariant);

const css = genCSS(light, dark);

export const styling = writable(css);
