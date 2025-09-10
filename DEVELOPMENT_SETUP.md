# 🚀 JMail PWA Development Setup

## Quick Start

### Option 1: Full Development Environment (Recommended)
**Provides long-lasting authentication like production**

```bash
# Run this batch file
start-dev.bat
```

This will:
- Install required tools (if missing)
- Create `api/local.settings.json` from template (if missing)
- Start both frontend (port 5173) and API (port 4280)
- Enable server-side authentication with long-lasting tokens

### Option 2: Frontend Only (Quick Testing)
**Uses client-side authentication (1-hour tokens)**

```bash
# Run this batch file
start-frontend-only.bat
```

This will:
- Start only the frontend on port 5173
- Use client-side Google Identity Services
- Require localhost OAuth client setup

## First-Time Setup

### 1. Install Global Dependencies
```bash
pnpm install -g @azure/static-web-apps-cli azure-functions-core-tools@4
```

### 2. Configure Google OAuth

#### For Full Development (start-dev.bat):
1. Go to [Google Cloud Console](https://console.cloud.google.com/apis/credentials)
2. Create OAuth 2.0 Client ID (Web application)
3. Add redirect URI: `http://localhost:4280/api/google-callback`
4. Copy Client ID and Client Secret
5. Edit `api/local.settings.json` with your credentials

#### For Frontend Only (start-frontend-only.bat):
1. Create separate OAuth 2.0 Client ID for development
2. Add authorized origins: `http://localhost:5173`
3. Use the diagnostic page to configure the Client ID

### 3. Generate Secrets
For `api/local.settings.json`, generate random 32-character strings:
```javascript
// Run in browser console
crypto.getRandomValues(new Uint8Array(32)).join('')
```

## Configuration Files

### api/local.settings.json
```json
{
  "IsEncrypted": false,
  "Values": {
    "AzureWebJobsStorage": "",
    "FUNCTIONS_WORKER_RUNTIME": "node",
    "GOOGLE_CLIENT_ID": "your-oauth-client-id.apps.googleusercontent.com",
    "GOOGLE_CLIENT_SECRET": "your-oauth-client-secret",
    "APP_BASE_URL": "http://localhost:4280",
    "COOKIE_SECRET": "your-32-char-secret-key-here-123456",
    "COOKIE_SIGNING_SECRET": "your-other-32-char-secret-here-78901",
    "COOKIE_SECURE": "false"
  }
}
```

## Development Workflow

### Full Development
```bash
start-dev.bat
# Visit: http://localhost:5173
# Complete OAuth flow → Long-lasting tokens
# Close browser, reopen → Still authenticated! ✅
```

### Frontend Only
```bash
start-frontend-only.bat
# Visit: http://localhost:5173
# Go to /diagnostics → Configure Client ID
# Authentication works for 1 hour
```

## Troubleshooting

### Common Issues

1. **"Azure Static Web Apps CLI not found"**
   - Install: `pnpm install -g @azure/static-web-apps-cli`

2. **"Azure Functions Core Tools not found"**
   - Install: `pnpm install -g azure-functions-core-tools@4`

3. **OAuth popup closes immediately**
   - Check authorized origins/redirect URIs in Google Cloud Console
   - Use diagnostic page to verify configuration

4. **API returns 404 errors**
   - Make sure you're using `start-dev.bat` (not `start-frontend-only.bat`)
   - Check that `api/local.settings.json` exists and is configured

### Diagnostic Tools

Visit `/diagnostics` for:
- Localhost authentication setup
- OAuth configuration help
- Server connectivity tests
- Authentication status checks

## Port Configuration

- **Frontend**: `localhost:5173` (Vite dev server)
- **API**: `localhost:4280` (SWA CLI proxy)
- **Combined**: Access via `localhost:5173` (proxied through SWA CLI)

The SWA CLI automatically proxies API requests from the frontend to the backend, simulating the production environment.
