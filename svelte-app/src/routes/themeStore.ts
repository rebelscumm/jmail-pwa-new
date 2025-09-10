import { writable } from "svelte/store";
import { Hct, SchemeTonalSpot, Variant } from "@ktibow/material-color-utilities-nightly";
import { genCSS } from "$lib/misc/utils";

// Seed from favicon's blue (#1a73e8) for a Google-like palette
const seed = Hct.fromInt(0x1a73e8).toInt();
const lightContrast = 0;
const darkContrast = 0.5; // Increased contrast for better dark mode readability
const initialVariant = Variant.VIBRANT;
const light = new (SchemeTonalSpot as any)(Hct.fromInt(seed), false, lightContrast, initialVariant);
const dark = new (SchemeTonalSpot as any)(Hct.fromInt(seed), true, darkContrast, initialVariant);

// Brand colors taken from favicon
const brandPrimary = [26, 115, 232];   // #1a73e8
const brandSecondary = [52, 168, 83];  // #34a853
const brandTertiary = [234, 67, 53];   // #ea4335
const brandError = [234, 67, 53];      // #ea4335
const on = (rgb: number[]) => {
  const [r, g, b] = rgb;
  const y = r * 0.299 + g * 0.587 + b * 0.114;
  return y > 186 ? [0, 0, 0] : [255, 255, 255];
};

const css = genCSS(light, dark);
const overrides = `
@media (prefers-color-scheme: light) {
  :root, ::backdrop {
    --m3-scheme-primary: ${brandPrimary.join(" ")};
    --m3-scheme-on-primary: ${on(brandPrimary).join(" ")};
    --m3-scheme-secondary: ${brandSecondary.join(" ")};
    --m3-scheme-on-secondary: ${on(brandSecondary).join(" ")};
    --m3-scheme-tertiary: ${brandTertiary.join(" ")};
    --m3-scheme-on-tertiary: ${on(brandTertiary).join(" ")};
    --m3-scheme-error: ${brandError.join(" ")};
    --m3-scheme-on-error: ${on(brandError).join(" ")};
  }
}
@media (prefers-color-scheme: dark) {
  :root, ::backdrop {
    --m3-scheme-primary: ${brandPrimary.join(" ")};
    --m3-scheme-on-primary: ${on(brandPrimary).join(" ")};
    --m3-scheme-secondary: ${brandSecondary.join(" ")};
    --m3-scheme-on-secondary: ${on(brandSecondary).join(" ")};
    --m3-scheme-tertiary: ${brandTertiary.join(" ")};
    --m3-scheme-on-tertiary: ${on(brandTertiary).join(" ")};
    --m3-scheme-error: ${brandError.join(" ")};
    --m3-scheme-on-error: ${on(brandError).join(" ")};
  }
}`;

export const styling = writable(css + overrides);
