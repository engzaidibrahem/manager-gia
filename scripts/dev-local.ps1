$ErrorActionPreference = "Stop"
Set-Location (Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path))

Write-Host "Gia V3 — use one of:" -ForegroundColor Green
Write-Host "  pnpm.cmd run dev:v3          # API on :5000 with canonical .data/gia-v3"
Write-Host "  pnpm.cmd run dev:web         # UI on :5173"
Write-Host "  START-GIA-V3.bat             # double-click both"
Write-Host ""
Write-Host "Canonical DB: $PWD\.data\gia-v3" -ForegroundColor Yellow
Write-Host "Open: http://localhost:5173" -ForegroundColor Green
Write-Host ""
Write-Host "OBSOLETE for V3: pnpm run dev:api (points at legacy gia-shawarma)" -ForegroundColor DarkYellow
Write-Host "OBSOLETE: setting relative DATABASE_URL while relying on process.cwd()" -ForegroundColor DarkYellow
