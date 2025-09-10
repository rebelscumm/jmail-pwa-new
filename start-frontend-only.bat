@echo off
echo Starting JMail PWA Frontend Only (Client-Side Auth)
echo ==================================================

REM Change to the directory where the batch file is located
cd /d "%~dp0"

REM Check if dependencies are installed
if not exist "svelte-app\node_modules" (
    echo Installing frontend dependencies...
    cd svelte-app
    npm install
    cd ..
)

echo.
echo Starting frontend development server...
echo - Frontend: http://localhost:5173
echo - Note: This uses client-side authentication (1-hour tokens)
echo - For long-lasting tokens, use start-dev.bat instead
echo.
echo Press Ctrl+C to stop the server
echo.

cd svelte-app
npm run dev -- --port 5173 --force
