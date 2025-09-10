# 🏠 Localhost Authentication Setup

## Two Options for Local Development

### Option 1: Server-Side Auth with SWA CLI (Recommended)

This enables the **same long-lasting tokens** as production:

#### 1. Install Azure Static Web Apps CLI
```bash
npm install -g @azure/static-web-apps-cli
npm install -g azure-functions-core-tools@4
```

#### 2. Set up local environment
Create `api/local.settings.json`:
```json
{
  "IsEncrypted": false,
  "Values": {
    "AzureWebJobsStorage": "",
    "FUNCTIONS_WORKER_RUNTIME": "node",
    "GOOGLE_CLIENT_ID": "your-client-id",
    "GOOGLE_CLIENT_SECRET": "your-client-secret",
    "APP_BASE_URL": "http://localhost:4280",
    "COOKIE_SECRET": "your-32-char-secret-key-here-123456",
    "COOKIE_SIGNING_SECRET": "your-other-32-char-secret-here-78901",
    "COOKIE_SECURE": "false"
  }
}
```

#### 3. Update Google Cloud Console
Add localhost redirect URI:
```
http://localhost:4280/api/google-callback
```

#### 4. Run with SWA CLI
```bash
# In project root
swa start ./svelte-app --api-location ./api --run "npm run dev --prefix svelte-app"
```

This runs:
- Frontend on `http://localhost:5173`
- APIs on `http://localhost:4280` 
- **Long-lasting auth works!** ✅

### Option 2: Client-Side GIS Fallback

For quick testing without server setup:

#### 1. Create Development Client ID
1. Go to [Google Cloud Console](https://console.cloud.google.com/apis/credentials)
2. Create new OAuth 2.0 Client ID
3. Add authorized origins:
   ```
   http://localhost:5173
   http://127.0.0.1:5173
   ```

#### 2. Configure Client ID
In browser console or localStorage:
```javascript
localStorage.setItem('LOCALHOST_GOOGLE_CLIENT_ID', 'your-dev-client-id');
```

#### 3. Run Vite Dev Server
```bash
cd svelte-app
npm run dev
```

Visit `http://localhost:5173` - will use GIS client auth.

**Note**: This provides **short-lived tokens** (1 hour), not long-lasting like server auth.

## How the System Works

### Localhost Detection
The system automatically detects localhost and:

1. **Tries SWA CLI first** (port 4280) for server auth
2. **Falls back to production API** if available  
3. **Falls back to GIS client auth** if server unavailable
4. **Graceful degradation** if nothing works

### Authentication Flow
```javascript
// Localhost auth priority:
1. Server session (SWA CLI) → Long-lasting ✅
2. Server session (production) → Long-lasting ✅  
3. GIS client auth → Short-lived (1 hour)
4. No auth → Show login UI
```

### API Routing
- **SWA CLI**: `http://localhost:4280/api/*` → Full server functionality
- **Vite Dev**: `http://localhost:5173/api/*` → Proxied to production or direct Gmail API
- **Production**: `https://your-app.azurestaticapps.net/api/*` → Full functionality

## Recommended Workflow

### For Long-Lasting Auth Testing:
```bash
# Terminal 1: Start SWA CLI (includes APIs)
swa start ./svelte-app --api-location ./api --run "npm run dev --prefix svelte-app"

# Visit: http://localhost:5173
# Complete OAuth flow → Gets long-lasting tokens
# Close browser, reopen → Still authenticated! ✅
```

### For Quick Frontend Development:
```bash
# Terminal 1: Just Vite dev server
cd svelte-app && npm run dev

# Visit: http://localhost:5173
# Uses GIS client auth for immediate access
# Shorter sessions but faster iteration
```

## Environment Variables

### Required for SWA CLI (`api/local.settings.json`):
```json
{
  "Values": {
    "GOOGLE_CLIENT_ID": "your-client-id",
    "GOOGLE_CLIENT_SECRET": "your-client-secret",
    "APP_BASE_URL": "http://localhost:4280",
    "COOKIE_SECRET": "generate-32-char-secret",
    "COOKIE_SIGNING_SECRET": "generate-different-32-char-secret",
    "COOKIE_SECURE": "false"
  }
}
```

### Optional for GIS Fallback:
```javascript
// In browser localStorage
localStorage.setItem('LOCALHOST_GOOGLE_CLIENT_ID', 'your-dev-client-id');
```

## Testing Your Setup

1. **Test Server Auth**: Use SWA CLI, complete OAuth, close browser, reopen → should stay logged in
2. **Test Client Auth**: Use Vite dev only, sign in → works for 1 hour
3. **Test Production**: Deploy and test on Azure → long-lasting auth works

Your localhost setup now supports both **long-lasting server auth** (like your Python apps) and **quick GIS fallback** for development! 🎉
