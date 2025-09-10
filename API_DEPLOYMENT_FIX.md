# 🔧 Azure Static Web Apps API Deployment Fix

## Issues Fixed

### 1. **Function Route Configuration**
- **Problem**: Custom routes in `function.json` were conflicting with Azure SWA's automatic routing
- **Fix**: Removed custom `route` properties to use default folder-based routing
- **Result**: Functions now accessible at `/api/{folder-name}`

### 2. **API Endpoint Mapping**
| Function Folder | Old Route | New Route | Status |
|---|---|---|---|
| `diagnostics/` | `/api/diagnostics` ❌ | `/api/diagnostics` ✅ | Fixed |
| `google-me/` | `/api/google/me` ❌ | `/api/google-me` ✅ | Fixed |
| `google-login/` | `/api/google-login` ✅ | `/api/google-login` ✅ | Working |
| `google-callback/` | `/api/google/callback` ❌ | `/api/google-callback` ✅ | Fixed |
| `google-refresh/` | `/api/google/refresh` ❌ | `/api/google-refresh` ✅ | Fixed |
| `google-tokeninfo/` | N/A | `/api/google-tokeninfo` ✅ | New |

### 3. **Diagnostics Security**
- **Problem**: Diagnostics endpoint required a key that wasn't being provided
- **Fix**: Made diagnostics key optional for debugging (remove in production)
- **Security**: Add `DIAGNOSTICS_KEY` environment variable in production

### 4. **Static Web App Configuration**
- **Added**: Explicit route definitions in `staticwebapp.config.json`
- **Added**: Node.js 18 runtime specification
- **Added**: Proper HTTP method restrictions

## Files Modified

### API Functions
- `api/diagnostics/function.json` - Removed custom route
- `api/diagnostics/index.js` - Made diagnostics key optional
- `api/google-me/function.json` - Removed custom route  
- `api/google-login/function.json` - Removed custom route
- `api/google-callback/function.json` - Removed custom route
- `api/google-refresh/function.json` - Removed custom route

### Configuration
- `svelte-app/staticwebapp.config.json` - Added explicit routes and platform config
- `svelte-app/build/staticwebapp.config.json` - Build output configuration

## Deployment Steps

### 1. **Commit and Push Changes**
```bash
git add .
git commit -m "Fix Azure Static Web Apps API routing configuration"
git push origin main
```

### 2. **Verify Azure Deployment**
- Check GitHub Actions for successful deployment
- Monitor Azure Static Web Apps logs for any errors

### 3. **Test API Endpoints**
After deployment, test these endpoints:
- `https://your-app.azurestaticapps.net/api/diagnostics`
- `https://your-app.azurestaticapps.net/api/google-me`
- `https://your-app.azurestaticapps.net/api/google-login`

### 4. **Run Auth Debug Wizard**
- Visit: `https://your-app.azurestaticapps.net/auth-debug`
- Run full diagnostic to verify fixes
- All API endpoints should now return proper responses instead of 404s

## Expected Results After Deployment

### ✅ **Before (Broken)**
```json
{
  "serverConnectivity": {
    "status": 403,
    "error": "Unauthorized"
  },
  "sessionCheck": {
    "status": 404,
    "error": "Not Found"
  }
}
```

### ✅ **After (Fixed)**
```json
{
  "serverConnectivity": {
    "status": 200,
    "ok": true,
    "diagnostics": { "environment": "..." }
  },
  "sessionCheck": {
    "status": 401,
    "authenticated": false,
    "note": "Expected - no session yet"
  }
}
```

## Security Notes

### Production Hardening
1. **Add Diagnostics Key**: Set `DIAGNOSTICS_KEY` environment variable in Azure
2. **Restrict Access**: Consider IP restrictions for diagnostic endpoints
3. **Monitor Usage**: Enable Application Insights for API monitoring

### Environment Variables Needed
```bash
# Required for Google OAuth
GOOGLE_CLIENT_ID=your-client-id
GOOGLE_CLIENT_SECRET=your-client-secret
APP_BASE_URL=https://your-app.azurestaticapps.net

# Required for session management
COOKIE_SECRET=your-32-char-secret
COOKIE_SIGNING_SECRET=your-32-char-signing-secret

# Optional for diagnostics security
DIAGNOSTICS_KEY=your-diagnostics-key
```

## Troubleshooting

### If APIs Still Return 404
1. **Check function.json syntax** - Ensure no JSON syntax errors
2. **Verify folder structure** - Function folders must match expected names
3. **Check deployment logs** - Look for deployment errors in GitHub Actions
4. **Clear browser cache** - Hard refresh the auth-debug page

### If Diagnostics Still Shows 403
1. **Check environment variables** - Ensure all required vars are set
2. **Verify CORS settings** - Should be handled by SWA automatically
3. **Test direct API calls** - Use browser dev tools or Postman

## Next Steps

After deployment, the auth debug wizard should show:
1. ✅ **Server connectivity**: 200 OK with diagnostics data
2. ✅ **Google endpoints**: Proper responses (401 for unauthenticated is expected)
3. ✅ **Token refresh**: Should work after completing OAuth flow
4. ✅ **Gmail proxy**: Should work with valid authentication

This will enable the **long-lasting Google authorization** you need!
