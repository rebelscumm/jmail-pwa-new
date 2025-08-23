export const prerender = true;

import type { RequestHandler } from '@sveltejs/kit';
import { appVersion, buildId } from '$lib/utils/version';

export const GET: RequestHandler = async () => {
	return new Response(
		JSON.stringify({ appVersion, buildId }),
		{
			headers: {
				'content-type': 'application/json; charset=utf-8',
				'cache-control': 'no-store, max-age=0'
			}
		}
	);
};