export const appVersion: string = (import.meta.env.VITE_APP_VERSION as string) || 'dev';

// Build identifier: prefer Vite-provided env or fallback to date-based string
export const buildId: string = (import.meta.env.VITE_BUILD_ID as string) || new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);