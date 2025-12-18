/**
 * Health Check Endpoint
 * 
 * Returns a simple health status to verify the API server is running.
 * This endpoint is used by the frontend to detect server availability.
 */
const { setCorsHeaders } = require('../_lib/cors');

module.exports = async function (context, req) {
  const res = {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-cache, no-store, must-revalidate'
    },
    body: JSON.stringify({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      service: 'jmail-api'
    })
  };
  
  // Add CORS headers
  setCorsHeaders(req, res);
  
  context.res = res;
};












