import { appVersion, buildId } from '$lib/utils/version';

export type VersionInfo = { appVersion: string; buildId: string };

export type StartOptions = {
	intervalMs?: number;
	immediate?: boolean;
};

/**
 * Starts a version watcher that fetches '/version.json' and compares build ids.
 * Calls `onNewVersion` once when a newer build is detected, then stops.
 * Returns a cleanup function to stop the watcher.
 */
export function startUpdateChecker(
	onNewVersion: (remote: VersionInfo, current: VersionInfo) => void,
	options: StartOptions = {}
): () => void {
	const { intervalMs = 15 * 60 * 1000, immediate = true } = options;
	let stopped = false;
	let intervalId: number | null = null;
	let bc: BroadcastChannel | null = null;

	const current: VersionInfo = { appVersion, buildId };

	const stop = () => {
		stopped = true;
		if (intervalId != null) window.clearInterval(intervalId);
		intervalId = null;
		if (bc) {
			try { bc.close(); } catch {}
			bc = null;
		}
		window.removeEventListener('visibilitychange', onVisibilityChange);
		window.removeEventListener('online', onOnline);
	};

	const ensureBroadcastChannel = () => {
		if (bc) return bc;
		try {
			bc = new BroadcastChannel('version-updates');
			bc.onmessage = (ev) => {
				const msg = ev?.data || {};
				if (msg && msg.type === 'NEW_BUILD_AVAILABLE') {
					const remoteFromPeer: VersionInfo | null = msg.remote && msg.remote.buildId ? msg.remote : null;
					// Only notify if the peer indicates a different build than ours
					if (remoteFromPeer && remoteFromPeer.buildId !== current.buildId) {
						onNewVersion(remoteFromPeer, current);
						stop();
					}
				}
			};
		} catch {}
		return bc;
	};

	const notifyAllTabs = (remote: VersionInfo) => {
		try {
			const chan = ensureBroadcastChannel();
			chan && chan.postMessage({ type: 'NEW_BUILD_AVAILABLE', remote });
		} catch {}
	};

	const onVisibilityChange = () => {
		if (document.visibilityState === 'visible') void checkOnce();
	};
	const onOnline = () => { void checkOnce(); };

	async function fetchRemote(): Promise<VersionInfo | null> {
		try {
			const res = await fetch(`/version.json?ts=${Date.now()}`, { cache: 'no-store' });
			if (!res.ok) return null;
			const data = (await res.json()) as VersionInfo;
			if (!data || !data.buildId) return null;
			return data;
		} catch {
			return null;
		}
	}

	async function checkOnce() {
		if (stopped) return;
		const remote = await fetchRemote();
		if (!remote) return;
		if (isRemoteNewer(remote, current)) {
			onNewVersion(remote, current);
			notifyAllTabs(remote);
			stop();
		}
	}

	// Listen to other tabs' notifications to prompt here too
	ensureBroadcastChannel();

	window.addEventListener('visibilitychange', onVisibilityChange);
	window.addEventListener('online', onOnline);
	if (immediate) void checkOnce();
	intervalId = window.setInterval(() => { void checkOnce(); }, intervalMs);
	return stop;
}

/** Returns the current app version information. */
export function getCurrentVersionInfo(): VersionInfo {
	return { appVersion, buildId };
}

/** Fetches the remote version information from '/version.json'. Returns null on failure. */
export async function fetchRemoteVersionInfo(): Promise<VersionInfo | null> {
	try {
		const res = await fetch(`/version.json?ts=${Date.now()}`, { cache: 'no-store' });
		if (!res.ok) return null;
		const data = (await res.json()) as VersionInfo;
		if (!data || !data.buildId) return null;
		return data;
	} catch {
		return null;
	}
}

export type CheckOnceResult =
	| { status: 'new'; remote: VersionInfo; current: VersionInfo }
	| { status: 'same'; current: VersionInfo; remote?: VersionInfo }
	| { status: 'offline'; current: VersionInfo }
	| { status: 'error'; current: VersionInfo };

/**
 * Performs a one-shot update check and returns a structured result.
 * Does not schedule future checks.
 */
export async function checkForUpdateOnce(): Promise<CheckOnceResult> {
	const current = getCurrentVersionInfo();
	try {
		if (typeof navigator !== 'undefined' && 'onLine' in navigator && (navigator as any).onLine === false) {
			return { status: 'offline', current };
		}
	} catch {}
	const remote = await fetchRemoteVersionInfo();
	if (!remote) return { status: 'error', current };
	if (isRemoteNewer(remote, current)) {
		return { status: 'new', remote, current };
	}
	return { status: 'same', current, remote };
}

/** Navigates with a hard reload parameter to ensure newest assets are loaded. */
export function hardReloadNow(): void {
	try {
		const url = new URL(window.location.href);
		// Use the existing refresh flow in +layout to clear caches and unregister SW
		url.searchParams.set('refresh', '1');
		window.location.assign(url.toString());
	} catch {}
}

/** Returns true if the remote version is actually newer than current. */
function isRemoteNewer(remote: VersionInfo, current: VersionInfo): boolean {
	// 1) Try semver compare on appVersion
	const semverCmp = compareSemver(remote.appVersion, current.appVersion);
	if (semverCmp !== 0) return semverCmp > 0;

	// 2) Fallback to timestamp-like buildId compare (e.g., YYYYMMDDHHmmss); lexicographic compare works when lengths match
	if (remote.buildId && current.buildId && remote.buildId.length === current.buildId.length) {
		if (isAllDigits(remote.buildId) && isAllDigits(current.buildId)) {
			return remote.buildId > current.buildId;
		}
		return remote.buildId > current.buildId;
	}

	// 3) If we cannot determine recency, do not prompt
	return false;
}

function isAllDigits(s: string): boolean {
	for (let i = 0; i < s.length; i++) {
		const c = s.charCodeAt(i);
		if (c < 48 || c > 57) return false;
	}
	return true;
}

/** Simple semver comparator: returns 1 if a>b, -1 if a<b, 0 if equal */
function compareSemver(a: string, b: string): number {
	const parse = (v: string) => v.split('.').map((x) => parseInt(x, 10)).map((n) => (Number.isFinite(n) ? n : 0));
	const aa = parse(a);
	const bb = parse(b);
	const len = Math.max(aa.length, bb.length);
	for (let i = 0; i < len; i++) {
		const ai = aa[i] ?? 0;
		const bi = bb[i] ?? 0;
		if (ai > bi) return 1;
		if (ai < bi) return -1;
	}
	return 0;
}