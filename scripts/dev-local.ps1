$ErrorActionPreference = "Stop"
Set-Location (Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path))

Write-Host "Building API..." -ForegroundColor Cyan
npx pnpm@10 --filter @workspace/api-server run build

Write-Host ""
Write-Host "Run in two terminals:" -ForegroundColor Green
Write-Host "  Terminal 1 (API):  npx pnpm@10 dev:api"
Write-Host "  Terminal 2 (Web):  npx pnpm@10 dev:web"
Write-Host ""
Write-Host "Open: http://localhost:5173" -ForegroundColor Green
Write-Host "Database: embedded PGlite in .data/gia-shawarma (no Docker needed)" -ForegroundColor Yellow
