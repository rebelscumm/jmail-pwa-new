import { version as kitVersion } from '$app/environment';

export const appVersion: string = (import.meta.env.VITE_APP_VERSION as string) || kitVersion;

// Build identifier: prefer Vite-provided env or SvelteKit build version
export const buildId: string = (import.meta.env.VITE_BUILD_ID as string) || kitVersion;