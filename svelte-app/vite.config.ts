import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vite";

// Compute build identifiers at config time
const appVersion = process.env.npm_package_version || "dev";
const buildId = process.env.VITE_BUILD_ID || new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);

export default defineConfig({
  plugins: [sveltekit()],
  define: {
    'import.meta.env.VITE_APP_VERSION': JSON.stringify(appVersion),
    'import.meta.env.VITE_BUILD_ID': JSON.stringify(buildId)
  }
});
