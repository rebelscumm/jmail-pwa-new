import { version as kitVersion } from '$app/environment';

const safeVersion = (v: unknown): string => (typeof v === 'string' && v ? v : '');

export const appVersion: string = safeVersion(import.meta.env.VITE_APP_VERSION) || safeVersion(kitVersion) || '5.1.3';

// Build identifier: prefer Vite-provided env or SvelteKit build version
export const buildId: string = safeVersion(import.meta.env.VITE_BUILD_ID) || safeVersion(kitVersion) || 'dev';