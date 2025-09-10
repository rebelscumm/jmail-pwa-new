# 🔧 OAuth Callback URL Fix

## Issue Fixed
The Google OAuth callback was returning 404 because of a URL mismatch between the configured redirect URI and the actual Azure Function endpoint.

## Root Cause
- **Expected**: `/api/google/callback` (old custom route)
- **Actual**: `/api/google-callback` (folder-based route)
- **Result**: 404 error after successful Google OAuth

## Fixes Applied

### 1. **Updated Server-Side Redirect URIs**
Fixed in these files:
- `api/google-login/index.js` - Line 11
- `api/google-callback/index.js` - Line 13  
- `api/diagnostics/index.js` - Line 48

**Before:**
```javascript
const redirectUri = (process.env.APP_BASE_URL || "") + "/api/google/callback";
```

**After:**
```javascript
const redirectUri = (process.env.APP_BASE_URL || "") + "/api/google-callback";
```

### 2. **Added Route Alias for Backward Compatibility**
Added to `svelte-app/staticwebapp.config.json`:
```json
{
  "route": "/api/google/callback",
  "rewrite": "/api/google-callback",
  "methods": ["GET"],
  "allowedRoles": ["anonymous"]
}
```

This ensures both URLs work:
- `/api/google/callback` → redirects to `/api/google-callback`
- `/api/google-callback` → works directly

## Google Cloud Console Update Required

### ⚠️ **IMPORTANT**: Update OAuth Client Configuration

You need to update your Google Cloud Console OAuth client:

1. **Go to**: [Google Cloud Console > Credentials](https://console.cloud.google.com/apis/credentials)
2. **Find**: Your OAuth 2.0 Client ID
3. **Edit**: Authorized redirect URIs
4. **Update**: Change from:
   ```
   https://polite-coast-0d53a9710.1.azurestaticapps.net/api/google/callback
   ```
   **To**:
   ```
   https://polite-coast-0d53a9710.1.azurestaticapps.net/api/google-callback
   ```

### Alternative: Keep Both URLs
Or add both URLs to be safe:
```
https://polite-coast-0d53a9710.1.azurestaticapps.net/api/google/callback
https://polite-coast-0d53a9710.1.azurestaticapps.net/api/google-callback
```

## Testing After Fix

### 1. **Deploy Changes**
```bash
git add .
git commit -m "Fix OAuth callback URL mismatch"
git push origin main
```

### 2. **Update Google Cloud Console**
- Update OAuth redirect URIs as described above

### 3. **Test OAuth Flow**
- Visit `/auth-debug`
- Click "🖥️ Server Login" 
- Should now complete successfully without 404

### 4. **Verify Long-Lasting Auth**
- Complete OAuth flow once
- Close browser completely
- Reopen and visit your app
- Should automatically redirect to inbox (no re-auth needed)

## Expected Results

### ✅ **Before Fix (Broken)**
```
Google OAuth → /api/google/callback → 404 Error
```

### ✅ **After Fix (Working)**
```
Google OAuth → /api/google-callback → Success → Redirect to app with cookies
```

The OAuth flow should now complete successfully and provide the long-lasting authentication tokens you need!
