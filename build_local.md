# Local Development Setup

This guide explains how to run the JMail PWA locally with full API support.

## Required Ports — DO NOT CHANGE

These exact ports are registered in Google Cloud Console OAuth settings. Changing them will cause `invalid_client` or redirect errors.

| Port | Service | Google Console Dependency |
|------|---------|---------------------------|
| **4280** | SWA CLI (main app) | Authorized redirect URI: `http://localhost:4280/api/google-callback` |
| **5173** | Vite dev server | Authorized JavaScript origin: `http://localhost:5173` |
| **7071** | Azure Functions API | None (internal only) |

**Access the app at http://localhost:4280** — this is the OAuth redirect target.

### Clearing Ports Before Starting

If any port is already in use, Vite or SWA will pick a different port and OAuth will fail. Kill existing processes first:

```powershell
# Kill func.exe and any processes on required ports
taskkill /IM func.exe /F 2>$null
netstat -ano | findstr ":4280 :5173 :7071" | ForEach-Object { $_ -match '\s+(\d+)$'; taskkill /PID $matches[1] /F 2>$null }
```

## Prerequisites

Install these global tools (one-time setup):

```bash
npm install -g @azure/static-web-apps-cli
npm install -g azure-functions-core-tools@4
```

## Configuration

1. Ensure `api/local.settings.json` exists with your credentials:
   - `GOOGLE_CLIENT_ID` — Your Google OAuth Client ID
   - `GOOGLE_CLIENT_SECRET` — Your Google OAuth Client Secret
   - `COOKIE_SECRET` — A 32-character random string
   - `COOKIE_SIGNING_SECRET` — Another 32-character random string

   If the file doesn't exist, copy from `api/local.settings.example.json` and fill in the values.

2. Install frontend dependencies (if not already installed):
   ```bash
   cd svelte-app
   pnpm install
   ```

## Starting the Full Environment

From the project root (`jmail-pwa-new`):

```powershell
# 1. Clear ports first (especially after reboot or if previous session crashed)
taskkill /IM func.exe /F 2>$null
netstat -ano | findstr ":4280 :5173 :7071" | ForEach-Object { $_ -match '\s+(\d+)$'; taskkill /PID $matches[1] /F 2>$null }

# 2. Start the environment
cd "C:\Users\jmeng\OneDrive\repos\rebelscumm\jmail-pwa-new"
swa start ./svelte-app --api-location ./api --run "cd svelte-app && pnpm dev -- --port 5173 --force" --port 4280
```

This starts:
| Service | URL | Description |
|---------|-----|-------------|
| **Combined App** | http://localhost:4280 | Use this URL — proxies frontend + API |
| Frontend (Vite) | http://localhost:5173 | Direct frontend access (auth won't work) |
| API Functions | http://localhost:7071 | Azure Functions backend |

**Important:** Always access the app via **http://localhost:4280** for authentication to work correctly.

## Alternative: Frontend Only

If you only need the frontend without API (limited functionality):

```bash
cd svelte-app
pnpm dev -- --port 5173
```

## Stopping the Environment

Press `Ctrl+C` in the terminal running the SWA CLI.

## Troubleshooting

### "Port 5173 is in use"
**Do not let Vite pick another port** — this will break Google OAuth. Kill the process using port 5173 first (see "Required Ports" section above), then restart.

### API proxy errors / blank page after sign-in
The API server isn't running. Make sure you're using the full `swa start` command, not just `pnpm dev`.

### "ECONNREFUSED" errors
The Azure Functions backend isn't responding. Check that:
1. `api/local.settings.json` exists and is valid JSON
2. Azure Functions Core Tools is installed (`func --version`)

### Google OAuth errors
Verify your OAuth credentials in `api/local.settings.json` and ensure your Google Cloud Console has `http://localhost:4280` as an authorized redirect URI.

### "Files prefixed with + are reserved" warning
SvelteKit reserves the `+` prefix for special files (`+page.svelte`, `+layout.ts`, etc.). If you see this warning, a backup or alternate file was accidentally created with a `+` prefix. Delete or rename the offending file:
```powershell
# Example: delete a backup file causing this warning
Remove-Item "svelte-app\src\routes\diagnostics\+layout-CyberPower.ts"
```

