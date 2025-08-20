<script lang="ts">
  import Button from "$lib/buttons/Button.svelte";
  import { base } from "$app/paths";
  
</script>

<div class="home">
  <Button variant="filled">Hello world</Button>

  <div class="nav-buttons">
    <Button href={base + "/UX"}>UX</Button>
    <Button variant="tonal" href={base + "/theme"}>Theme</Button>
    <Button variant="outlined" href={base + "/docs/quick-start"}>Documents</Button>
    <Button variant="text" href={base + "/transitions"}>Animations</Button>
  </div>
</div>

<style>
  .home {
    display: grid;
    place-items: center;
    min-height: 60dvh;
    gap: 1.5rem;
  }
  .nav-buttons {
    display: flex;
    gap: 0.75rem;
    flex-wrap: wrap;
    justify-content: center;
  }
</style>
