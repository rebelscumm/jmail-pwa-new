import { writable } from "svelte/store";
import { Hct, SchemeTonalSpot, Variant } from "@ktibow/material-color-utilities-nightly";
import { genCSS } from "$lib/misc/utils";

// Seed from favicon's blue (#1a73e8) for a Google-like palette
const seed = Hct.fromInt(0x1a73e8).toInt();
const contrast = 0; // Keep default contrast
const initialVariant = Variant.VIBRANT;
const light = new (SchemeTonalSpot as any)(Hct.fromInt(seed), false, contrast, initialVariant);
const dark = new (SchemeTonalSpot as any)(Hct.fromInt(seed), true, contrast, initialVariant);

const css = genCSS(light, dark);

export const styling = writable(css);
