@echo off
echo Cleaning JMail PWA Development Environment
echo ==========================================

REM Change to the directory where the batch file is located
cd /d "%~dp0"

echo Stopping any running dev servers...
taskkill /f /im node.exe >nul 2>&1
taskkill /f /im swa.exe >nul 2>&1

echo Cleaning Vite cache and node_modules...
cd svelte-app

REM Remove Vite cache
if exist "node_modules\.vite" (
    echo Removing Vite cache...
    rmdir /s /q "node_modules\.vite"
)

REM Remove dist/build directories
if exist "dist" (
    echo Removing dist directory...
    rmdir /s /q "dist"
)

if exist ".svelte-kit" (
    echo Removing .svelte-kit directory...
    rmdir /s /q ".svelte-kit"
)

echo Reinstalling dependencies...
npm install

echo.
echo Cleanup complete! Now you can run:
echo - start-dev.bat (for full server setup)
echo - start-frontend-only.bat (for frontend only)
echo.
pause
