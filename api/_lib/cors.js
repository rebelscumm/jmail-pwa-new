// CORS helper for Azure Functions
// Allows requests from localhost dev servers when credentials are included

function getAllowedOrigin(req) {
  // Get the origin from the request
  const origin = req.headers && req.headers.origin;
  
  // For localhost development, allow common dev ports
  if (origin) {
    const originUrl = new URL(origin);
    const hostname = originUrl.hostname.toLowerCase();
    const port = originUrl.port;
    
    // Allow localhost origins (common dev ports)
    if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname.startsWith('192.168.')) {
      return origin; // Return the specific origin
    }
    
    // In production, you might want to check against a whitelist
    // For now, return the origin if it's provided
    return origin;
  }
  
  // No origin header, return null (will use wildcard for non-credential requests)
  return null;
}

function setCorsHeaders(headers, req) {
  const origin = getAllowedOrigin(req);
  
  // Always set specific origin if available, never use wildcard with credentials
  if (origin) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Access-Control-Allow-Credentials'] = 'true';
    headers['Access-Control-Allow-Methods'] = 'GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD';
    headers['Access-Control-Allow-Headers'] = 'Content-Type, Authorization, X-Requested-With';
    headers['Access-Control-Max-Age'] = '3600';
    // Log for debugging (remove in production)
    try {
      console.log('[CORS] Setting headers for origin:', origin);
    } catch (_) {}
  } else {
    // If no origin header, check if this is a same-origin request
    // For same-origin, we don't need CORS headers
    // Only set wildcard if absolutely necessary (but this won't work with credentials)
    // Actually, don't set wildcard - let the browser handle same-origin requests naturally
    try {
      console.log('[CORS] No origin header found in request');
    } catch (_) {}
  }
  
  return headers;
}

module.exports = { setCorsHeaders, getAllowedOrigin };

