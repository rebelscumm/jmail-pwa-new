# PowerShell script to start development server with long-lasting auth

Write-Host "🚀 Starting JMail PWA with Long-Lasting Auth..." -ForegroundColor Cyan

# Check if we're in the right directory
if (-not (Test-Path "svelte-app" -PathType Container)) {
    Write-Host "❌ Error: Run this script from the project root directory" -ForegroundColor Red
    exit 1
}

# Check if SWA CLI is installed
try {
    $swaVersion = swa --version 2>$null
    if ($swaVersion) {
        Write-Host "✅ Using global SWA CLI" -ForegroundColor Green
        $swaCommand = "swa"
    }
} catch {
    # Try local installation
    if (Test-Path "node_modules/.bin/swa.cmd") {
        Write-Host "✅ Using local SWA CLI" -ForegroundColor Green
        $swaCommand = ".\node_modules\.bin\swa.cmd"
    } else {
        Write-Host "❌ SWA CLI not found. Installing..." -ForegroundColor Red
        npm install @azure/static-web-apps-cli azure-functions-core-tools@4 --save-dev
        $swaCommand = ".\node_modules\.bin\swa.cmd"
    }
}

# Check if local.settings.json exists
if (-not (Test-Path "api/local.settings.json")) {
    Write-Host "⚠️  Warning: api/local.settings.json not found" -ForegroundColor Yellow
    Write-Host "   Run scripts/dev-setup.ps1 first to create it" -ForegroundColor Yellow
}

Write-Host "🌐 Starting development server..." -ForegroundColor Yellow
Write-Host "   Frontend: http://localhost:5173" -ForegroundColor Gray
Write-Host "   APIs: http://localhost:4280" -ForegroundColor Gray
Write-Host ""
Write-Host "Press Ctrl+C to stop" -ForegroundColor Gray
Write-Host ""

# Start SWA CLI
& $swaCommand start ./svelte-app --api-location ./api --run "pnpm --prefix svelte-app dev"
