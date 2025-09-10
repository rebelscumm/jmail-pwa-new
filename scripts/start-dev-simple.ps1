# Simple development server (GIS client auth only)

Write-Host "🚀 Starting JMail PWA - Simple Development Mode" -ForegroundColor Cyan
Write-Host "   Frontend: http://localhost:5173" -ForegroundColor Gray
Write-Host "   Auth: GIS Client Auth (1-hour tokens)" -ForegroundColor Gray
Write-Host ""
Write-Host "Visit http://localhost:5173/auth-debug and click 'Enable GIS Client Auth'" -ForegroundColor Yellow
Write-Host ""
Write-Host "Press Ctrl+C to stop" -ForegroundColor Gray
Write-Host ""

Set-Location svelte-app
pnpm dev
