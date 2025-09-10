# 🚀 Complete OAuth Setup Guide

## Current Status: ✅ APIs Working, Need OAuth Flow

Your diagnostics show the system is working correctly:
- ✅ **Server endpoints responding** (401 is expected without auth)
- ✅ **API routing fixed** 
- ✅ **Environment healthy**
- ❌ **No refresh token** (need to complete OAuth flow)

## Step-by-Step Setup

### 1. **Deploy Callback Fix**
```bash
git add .
git commit -m "Fix OAuth callback URL routing"
git push origin main
```
Wait for GitHub Actions deployment to complete.

### 2. **Update Google Cloud Console**

1. **Go to**: [Google Cloud Console > Credentials](https://console.cloud.google.com/apis/credentials)
2. **Find**: Your OAuth 2.0 Client ID (ending in `apps.googleusercontent.com`)
3. **Click**: Edit (pencil icon)
4. **Update**: "Authorized redirect URIs"
   
   **Add this exact URL**:
   ```
   https://polite-coast-0d53a9710.1.azurestaticapps.net/api/google-callback
   ```
   
   **Remove the old one** (if present):
   ```
   https://polite-coast-0d53a9710.1.azurestaticapps.net/api/google/callback
   ```

5. **Click**: Save

### 3. **Complete OAuth Flow**

1. **Go to**: `https://polite-coast-0d53a9710.1.azurestaticapps.net/auth-debug`
2. **Click**: "🖥️ Server Login" button (in Controls section)
3. **Complete Google OAuth**:
   - Sign in with your Google account
   - Grant Gmail permissions
   - Should redirect back to auth-debug page

### 4. **Verify Success**

After completing OAuth, run diagnostics again. You should see:

#### ✅ **Expected Results:**
```json
{
  "sessionCheck": {
    "status": 200,
    "authenticated": true,
    "data": {
      "authenticated": true,
      "user": {
        "email": "your-email@gmail.com",
        "sub": "your-google-id"
      }
    }
  },
  "refreshCheck": {
    "status": 200,
    "success": true,
    "data": {
      "ok": true,
      "expires_in": 3599
    }
  }
}
```

### 5. **Test Long-Lasting Auth**

1. **Complete OAuth flow** (step 3)
2. **Close browser completely**
3. **Reopen browser** 
4. **Visit**: `https://polite-coast-0d53a9710.1.azurestaticapps.net/`
5. **Expected**: Should automatically redirect to inbox without re-authentication

## Troubleshooting

### If OAuth Still Fails:
1. **Check Google Cloud Console**: Ensure redirect URI is exactly correct
2. **Check deployment**: Verify GitHub Actions completed successfully
3. **Clear cookies**: Clear all cookies for your domain and try again
4. **Check logs**: Look at Function App logs in Azure portal

### If Diagnostics Timeout:
1. **Check Azure Function App**: Ensure it's running and not sleeping
2. **Check environment variables**: Verify all required env vars are set
3. **Check Function App logs**: Look for startup errors

### Environment Variables Required:
```
GOOGLE_CLIENT_ID=your-client-id
GOOGLE_CLIENT_SECRET=your-client-secret  
APP_BASE_URL=https://polite-coast-0d53a9710.1.azurestaticapps.net
COOKIE_SECRET=your-32-char-secret
COOKIE_SIGNING_SECRET=your-32-char-signing-secret
```

## Success Indicators

### ✅ **You'll know it's working when:**
1. **OAuth completes** without 404 errors
2. **Diagnostics show** `"authenticated": true` 
3. **Refresh tokens work** without `"no_refresh_token"` errors
4. **Home page** automatically redirects to inbox
5. **Sessions persist** across browser restarts

### 🎯 **End Goal Achieved:**
- **Long-lasting authentication** (weeks/months like Python apps)
- **Automatic token refresh** 
- **No re-authentication required**
- **Seamless user experience**

## Ready to Test!

Your system is properly configured. The 401 errors in diagnostics are **expected and normal** - they just mean you need to complete the OAuth flow once to get the long-lasting refresh tokens.

Follow the steps above and you should have working long-lasting Google authorization!
