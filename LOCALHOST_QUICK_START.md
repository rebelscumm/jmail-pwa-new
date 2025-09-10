# 🚀 Localhost Quick Start

## Your Current Situation
You're on `localhost:5173` with Vite dev server only. The diagnostics show API endpoints returning HTML because no backend is running.

## 🎯 Immediate Solution: Enable GIS Client Auth

**Right now, you can get working authentication in 2 minutes:**

### 1. **Get a Development Client ID** (if you don't have one)
1. Go to: https://console.cloud.google.com/apis/credentials
2. Click "Create Credentials" → "OAuth 2.0 Client ID"
3. Choose "Web application"
4. Add authorized origin: `http://localhost:5173`
5. Copy the Client ID

### 2. **Enable GIS Auth on Your Current Page**
1. **Go to**: `http://localhost:5173/auth-debug`
2. **Click**: "**Enable GIS Client Auth for Localhost**" button
3. **Paste your Client ID** when prompted (or use default)
4. **Complete Google OAuth** 
5. **Done!** - Visit `http://localhost:5173` and it should work

## 🔧 Alternative: Use NPM for SWA CLI

If you want the full server experience:

### Option A: Fix pnpm global setup
```powershell
pnpm setup
# Restart PowerShell
pnpm add -g @azure/static-web-apps-cli azure-functions-core-tools@4
```

### Option B: Use npm instead
```powershell
npm install -g @azure/static-web-apps-cli azure-functions-core-tools@4
```

### Option C: Use npx (no installation needed)
```powershell
npx @azure/static-web-apps-cli start ./svelte-app --api-location ./api --run "pnpm --prefix svelte-app dev"
```

## 📝 Created Helper Scripts

I've created PowerShell scripts for you:

### `scripts/dev-setup.ps1`
- Sets up local.settings.json
- Installs SWA CLI
- Prepares everything for long-lasting auth

### `scripts/start-dev.ps1` 
- Starts full SWA CLI development (long-lasting auth)
- Uses both frontend (5173) and API (4280) servers

### `scripts/start-dev-simple.ps1`
- Just starts Vite dev server
- For use with GIS client auth

## 🎯 Recommended Right Now

**For immediate testing:**
1. Use the "Enable GIS Client Auth" button on your current auth-debug page
2. This gives you working authentication in 2 minutes
3. Test your app functionality with 1-hour tokens

**For production-like testing:**
1. Run: `npx @azure/static-web-apps-cli start ./svelte-app --api-location ./api --run "pnpm --prefix svelte-app dev"`
2. This gives you the same long-lasting tokens as production

## 🔍 Why Your Diagnostics Show HTML

The "<!DOCTYPE html..." responses are **expected** when running just Vite dev server:
- Vite serves the SvelteKit app for all routes
- `/api/*` routes return the main app HTML
- No actual API server is running
- This is normal for frontend-only development

**The GIS client auth option I added bypasses this limitation!** 🎉
