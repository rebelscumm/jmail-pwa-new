import pkg from '../../../package.json' assert { type: 'json' };

export const appVersion: string = pkg.version as string;

// Build identifier: prefer Vite-provided env or fallback to date-based string
const fromEnv = (import.meta as any).env?.VITE_BUILD_ID || (globalThis as any).VITE_BUILD_ID;
export const buildId: string = typeof fromEnv === 'string' && fromEnv.length > 0
	? fromEnv
	: new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);