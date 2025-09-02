module.exports = async function (context, req) {
  try {
    if ((req.method || 'GET').toUpperCase() !== 'POST') {
      context.res = { status: 405, headers: { Allow: 'POST' }, body: '' };
      return;
    }
    const payload = req.body || {};
    // Log structured telemetry to function logs for later inspection
    try { context.log('[collect-diagnostics] received', JSON.stringify(payload)); } catch (_) { context.log('[collect-diagnostics] received (unstringifiable payload)'); }
    // Optionally, we could persist to durable storage here. For now, return 204 No Content.
    context.res = { status: 204, body: '' };
  } catch (e) {
    try { context.log('[collect-diagnostics] error', e instanceof Error ? e.stack : String(e)); } catch (_) {}
    context.res = { status: 500, body: JSON.stringify({ error: 'server_error' }), headers: { 'Content-Type': 'application/json' } };
  }
};


