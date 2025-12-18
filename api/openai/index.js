const FORWARDED = [
  'x-ratelimit-limit-requests',
  'x-ratelimit-remaining-requests',
  'x-ratelimit-limit-tokens',
  'x-ratelimit-remaining-tokens',
  'retry-after',
  'x-request-id',
  'openai-request-id'
];

module.exports = async function (context, req) {
  if (req.method !== 'POST') {
    context.res = {
      status: 405,
      headers: { 'Allow': 'POST', 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Method not allowed' })
    };
    return;
  }

  const body = req.body || {};
  const apiKey = body.apiKey || process.env.OPENAI_API_KEY;
  if (!apiKey) {
    context.res = {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'OPENAI_API_KEY not set' })
    };
    return;
  }

  const model = body.model || 'gpt-4o-mini';
  const messages = body.messages || [{ role: 'user', content: 'Hello' }];
  const temperature = body.temperature ?? 0.2;

  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ model, messages, temperature })
  });

  const respText = await r.text();
  const headers = { 'Content-Type': 'application/json' };
  for (const h of FORWARDED) {
    const v = r.headers.get(h);
    if (v) headers[h] = v;
  }

  context.res = { status: r.status, headers, body: respText };
};


