export const prerender = false;

import type { RequestHandler } from '@sveltejs/kit';
import { OPENAI_API_KEY } from '$env/static/private';

export const POST: RequestHandler = async ({ request }) => {
  if (!OPENAI_API_KEY) {
    return new Response(JSON.stringify({ error: 'OPENAI_API_KEY not set' }), { status: 500 });
  }

  const body = await request.json().catch(() => ({}));
  const messages = body?.messages ?? [{ role: 'user', content: 'Hello' }];
  const model = body?.model ?? 'gpt-4o-mini';
  const temperature = body?.temperature ?? 0.2;

  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ model, messages, temperature })
  });

  const respHeaders = new Headers({ 'Content-Type': 'application/json' });
  const forward = [
    'x-ratelimit-limit-requests',
    'x-ratelimit-remaining-requests',
    'x-ratelimit-limit-tokens',
    'x-ratelimit-remaining-tokens',
    'retry-after',
    'x-request-id',
    'openai-request-id'
  ];
  for (const h of forward) {
    const v = r.headers.get(h);
    if (v) respHeaders.set(h, v);
  }

  return new Response(await r.text(), {
    status: r.status,
    headers: respHeaders
  });
};


