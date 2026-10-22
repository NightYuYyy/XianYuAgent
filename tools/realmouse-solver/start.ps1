# Start the Xianyu real-mouse slider solver service.
# Usage: powershell -ExecutionPolicy Bypass -File start.ps1
# Secret lives in .env next to this file: SOLVER_SECRET=xxxx (never commit it).
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot
if (Test-Path ".env") {
    Get-Content ".env" | ForEach-Object {
        if ($_ -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$') { [Environment]::SetEnvironmentVariable($matches[1], $matches[2].Trim('"'), "Process") }
    }
}
if (-not $env:SOLVER_SECRET) { Write-Error "SOLVER_SECRET missing; set it in .env"; exit 1 }
if (-not $env:SOLVER_HOST) { $env:SOLVER_HOST = "127.0.0.1" }
if (-not $env:SOLVER_PORT) { $env:SOLVER_PORT = "18095" }
$env:PYTHONIOENCODING = "utf-8"
& "$PSScriptRoot\.venv\Scripts\python.exe" "$PSScriptRoot\service.py"
