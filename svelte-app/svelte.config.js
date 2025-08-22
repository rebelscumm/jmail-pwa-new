import adapter from "@sveltejs/adapter-static";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";

/** @type {import('@sveltejs/kit').Config} */
const config = {
  preprocess: vitePreprocess(),
  kit: {
    adapter: adapter({ fallback: 'index.html', strict: false }),
    files: {
      assets: "public",
    },
    paths: {
      relative: false,
    },
    prerender: { handleHttpError: "warn" },
  },
};

export default config;
