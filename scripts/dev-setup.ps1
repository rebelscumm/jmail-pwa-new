# PowerShell script for setting up local development with long-lasting auth

Write-Host "🏠 JMail PWA - Local Development Setup" -ForegroundColor Cyan
Write-Host "===============================================" -ForegroundColor Cyan

# Check if we're in the right directory
if (-not (Test-Path "svelte-app" -PathType Container)) {
    Write-Host "❌ Error: Run this script from the project root directory" -ForegroundColor Red
    Write-Host "Expected to find 'svelte-app' folder in current directory" -ForegroundColor Red
    exit 1
}

Write-Host "📦 Installing Azure Static Web Apps CLI..." -ForegroundColor Yellow
try {
    npm install -g @azure/static-web-apps-cli azure-functions-core-tools@4 --silent
    Write-Host "✅ SWA CLI installed successfully" -ForegroundColor Green
} catch {
    Write-Host "❌ Failed to install SWA CLI. Trying alternative approach..." -ForegroundColor Red
    
    # Alternative: Install locally in project
    Write-Host "📦 Installing SWA CLI locally..." -ForegroundColor Yellow
    npm install @azure/static-web-apps-cli azure-functions-core-tools@4 --save-dev --silent
    Write-Host "✅ SWA CLI installed locally" -ForegroundColor Green
}

# Check if local.settings.json exists
$localSettingsPath = "api/local.settings.json"
if (-not (Test-Path $localSettingsPath)) {
    Write-Host "⚙️ Creating local.settings.json..." -ForegroundColor Yellow
    
    $localSettings = @{
        IsEncrypted = $false
        Values = @{
            AzureWebJobsStorage = ""
            FUNCTIONS_WORKER_RUNTIME = "node"
            GOOGLE_CLIENT_ID = "49551890193-e6n262ccj95229ftp2dh6k9s2boo1kip.apps.googleusercontent.com"
            GOOGLE_CLIENT_SECRET = "PLACEHOLDER_SET_YOUR_SECRET_HERE"
            APP_BASE_URL = "http://localhost:4280"
            COOKIE_SECRET = "dev-secret-key-32-chars-long-12345"
            COOKIE_SIGNING_SECRET = "dev-signing-key-32-chars-long-67890"
            COOKIE_SECURE = "false"
        }
    }
    
    $localSettings | ConvertTo-Json -Depth 3 | Out-File -FilePath $localSettingsPath -Encoding utf8
    Write-Host "✅ Created $localSettingsPath" -ForegroundColor Green
    Write-Host "⚠️  IMPORTANT: Set your GOOGLE_CLIENT_SECRET in $localSettingsPath" -ForegroundColor Yellow
} else {
    Write-Host "✅ $localSettingsPath already exists" -ForegroundColor Green
}

Write-Host ""
Write-Host "🚀 Ready to start development server!" -ForegroundColor Cyan
Write-Host ""
Write-Host "Choose your option:" -ForegroundColor White
Write-Host ""
Write-Host "Option 1 - Long-lasting auth (like production):" -ForegroundColor Green
Write-Host "  swa start ./svelte-app --api-location ./api --run `"pnpm --prefix svelte-app dev`"" -ForegroundColor Gray
Write-Host ""
Write-Host "Option 2 - Quick GIS auth (1-hour tokens):" -ForegroundColor Yellow
Write-Host "  cd svelte-app && pnpm dev" -ForegroundColor Gray
Write-Host "  Then visit http://localhost:5173/auth-debug and click 'Enable GIS Client Auth'" -ForegroundColor Gray
Write-Host ""
Write-Host "Recommendation: Try Option 1 first for full long-lasting auth testing!" -ForegroundColor Cyan
