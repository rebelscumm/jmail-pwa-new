import { writable } from "svelte/store";
import { Hct, SchemeTonalSpot, Variant } from "@ktibow/material-color-utilities-nightly";
import { genCSS } from "$lib/misc/utils";

// Seed from favicon's red (#ea4335) for a Gmail-like palette
const seed = Hct.fromInt(0xea4335).toInt();
const contrast = 0; // Keep default contrast
const initialVariant = Variant.VIBRANT;
const light = new (SchemeTonalSpot as any)(Hct.fromInt(seed), false, contrast, initialVariant);
const dark = new (SchemeTonalSpot as any)(Hct.fromInt(seed), true, contrast, initialVariant);

const css = genCSS(light, dark);

export const styling = writable(css);
