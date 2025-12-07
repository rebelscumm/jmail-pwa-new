<script lang="ts">
  import { Hct, SchemeTonalSpot, Variant, hexFromArgb } from '@ktibow/material-color-utilities-nightly';
  import { genCSS } from '$lib/misc/utils';
  import { deriveFaviconSeed, styling } from '../themeStore';
  import ColorChooser from './ColorChooser.svelte';
  import TransformChooser from './TransformChooser.svelte';
  import SchemeShowcase from './SchemeShowcase.svelte';

  const defaultSeed = deriveFaviconSeed();
  let sourceColor = $state(defaultSeed);
  let variant = $state<Variant>(Variant.TONAL_SPOT);
  let contrast = $state(0);

  let schemes: Record<Variant, { light: any; dark: any }> = $state({} as any);

  function computeSchemes() {
    const vList = Object.values(Variant).filter((v) => typeof v === 'number') as Variant[];
    const next: Record<Variant, { light: any; dark: any }> = {} as any;
    for (const v of vList) {
      const light = new (SchemeTonalSpot as any)(Hct.fromInt(sourceColor), false, contrast, v);
      const dark = new (SchemeTonalSpot as any)(Hct.fromInt(sourceColor), true, contrast, v);
      next[v] = { light, dark };
    }
    schemes = next;
  }

  $effect(computeSchemes);
</script>

<div style="display:grid; gap:1rem;">
  <div style="display:flex; gap:0.5rem; align-items:center;">
    <ColorChooser bind:sourceColor />
  </div>
  {#if schemes[variant]}
    <TransformChooser {schemes} bind:variant bind:contrast />
    <SchemeShowcase light={schemes[variant].light} dark={schemes[variant].dark} />
  {/if}
</div>

