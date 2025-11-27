# Local Development Restart Guide

This guide explains how to restart the JMail PWA locally after a reboot.

**Important context:**
- All tools and dependencies are already installed
- The environment has been running properly — nothing needs to be reinstalled
- This is only about restarting processes with the correct ports for GCP OAuth

> **For AI agents:** If terminal commands fail to start the server properly, ask the user to manually run the startup command in their PowerShell terminal.

## Required Ports — DO NOT CHANGE

These exact ports are registered in Google Cloud Console OAuth settings. Changing them will cause `invalid_client` or redirect errors.

| Port | Service | Google Console Dependency |
|------|---------|---------------------------|
| **4280** | SWA CLI (main app) | Authorized redirect URI: `http://localhost:4280/api/google-callback` |
| **5173** | Vite dev server | Authorized JavaScript origin: `http://localhost:5173` |
| **7071** | Azure Functions API | None (internal only) |

**Access the app at http://localhost:4280** — this is the OAuth redirect target.

## Starting the Full Environment

Open a PowerShell terminal and run this single command from the project root:

```powershell
cd "C:\Users\jmeng\OneDrive\repos\rebelscumm\jmail-pwa-new"; swa start ./svelte-app --api-location ./api --run "cd svelte-app && pnpm dev -- --port 5173 --force" --port 4280
```

Wait for output showing all three services are ready (Vite, Functions, and SWA proxy).

This starts:
| Service | URL | Description |
|---------|-----|-------------|
| **Combined App** | http://localhost:4280 | Use this URL — proxies frontend + API |
| Frontend (Vite) | http://localhost:5173 | Direct frontend access (auth won't work) |
| API Functions | http://localhost:7071 | Azure Functions backend |

**Important:** Always access the app via **http://localhost:4280** for authentication to work correctly.

## Alternative: Frontend Only

If you only need the frontend without API (limited functionality, no OAuth):

```powershell
cd "C:\Users\jmeng\OneDrive\repos\rebelscumm\jmail-pwa-new\svelte-app"; pnpm dev -- --port 5173
```

Access at http://localhost:5173

## Stopping the Environment

Press `Ctrl+C` in the terminal running the SWA CLI.

## Troubleshooting

### Port already in use

If any required port is in use, kill existing processes first:

```powershell
taskkill /IM func.exe /F 2>$null; taskkill /IM node.exe /F 2>$null
```

**Do not let Vite pick another port** — this will break Google OAuth.

### API proxy errors / blank page after sign-in
The API server isn't running. Make sure you're using the full `swa start` command, not just `pnpm dev`.

### "ECONNREFUSED" errors
The Azure Functions backend isn't responding. Check that `api/local.settings.json` exists and is valid JSON.

### Google OAuth errors
Verify your OAuth credentials in `api/local.settings.json` and ensure your Google Cloud Console has `http://localhost:4280` as an authorized redirect URI.

### "Files prefixed with + are reserved" warning
SvelteKit reserves the `+` prefix for special files (`+page.svelte`, `+layout.ts`, etc.). If you see this warning, a backup or alternate file was accidentally created with a `+` prefix. Delete or rename the offending file:
```powershell
# Example: delete a backup file causing this warning
Remove-Item "svelte-app\src\routes\diagnostics\+layout-CyberPower.ts"
```

