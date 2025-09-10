@echo off
echo Starting JMail PWA Development Environment
echo ==========================================

REM Change to the directory where the batch file is located
cd /d "%~dp0"

REM Check if required tools are installed
where swa >nul 2>nul
if %errorlevel% neq 0 (
    echo ERROR: Azure Static Web Apps CLI not found!
    echo.
    echo OPTION 1: Run install-tools.bat to install automatically
    echo OPTION 2: Install manually with: npm install -g @azure/static-web-apps-cli
    echo OPTION 3: Use start-frontend-only.bat for client-side auth only
    echo.
    pause
    exit /b 1
)

where func >nul 2>nul
if %errorlevel% neq 0 (
    echo ERROR: Azure Functions Core Tools not found!
    echo.
    echo OPTION 1: Run install-tools.bat to install automatically  
    echo OPTION 2: Install manually with: npm install -g azure-functions-core-tools@4
    echo OPTION 3: Use start-frontend-only.bat for client-side auth only
    echo.
    pause
    exit /b 1
)

REM Check if local.settings.json exists
if not exist "api\local.settings.json" (
    echo ERROR: api\local.settings.json not found!
    echo.
    echo Creating template file from api\local.settings.example.json...
    copy "api\local.settings.example.json" "api\local.settings.json"
    echo.
    echo IMPORTANT: Please edit api\local.settings.json with your Google OAuth credentials:
    echo - GOOGLE_CLIENT_ID: Your Google OAuth Client ID
    echo - GOOGLE_CLIENT_SECRET: Your Google OAuth Client Secret
    echo - COOKIE_SECRET: Generate a 32-character random string
    echo - COOKIE_SIGNING_SECRET: Generate another 32-character random string
    echo.
    echo Then run this script again.
    pause
    exit /b 1
)

REM Install frontend dependencies if needed
if not exist "svelte-app\node_modules" (
    echo Installing frontend dependencies...
    cd svelte-app
    npm install
    cd ..
)

echo.
echo Starting development servers...
echo - Frontend: http://localhost:5173
echo - API: http://localhost:4280
echo - Combined: Access via http://localhost:5173 (proxied through SWA CLI)
echo.
echo Press Ctrl+C to stop all servers
echo.

REM Start SWA CLI with both frontend and API
swa start ./svelte-app --api-location ./api --run "cd svelte-app && npm run dev -- --port 5173 --force" --port 4280
