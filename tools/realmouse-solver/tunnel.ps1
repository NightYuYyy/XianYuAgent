# Keep the reverse SSH tunnel for the real-mouse solver alive:
#   server94 172.17.0.1:18095  ->  this machine 127.0.0.1:18095
# fishagent on the server calls http://172.17.0.1:18095/api/v1/captcha/slider-solve.
# Usage: powershell -ExecutionPolicy Bypass -File tunnel.ps1   (run detached via run-detached.ps1)
$ErrorActionPreference = "Continue"
$ssh = "C:\Program Files\Git\usr\bin\ssh.exe"
if (-not (Test-Path $ssh)) { $ssh = "ssh" }
$log = Join-Path $PSScriptRoot "logs\tunnel.log"
New-Item -ItemType Directory -Force (Split-Path $log) | Out-Null
while ($true) {
    "$(Get-Date -Format s) connecting" | Add-Content $log
    & $ssh -o BatchMode=yes -o ExitOnForwardFailure=yes -o ServerAliveInterval=15 -o ServerAliveCountMax=3 -N -R 172.17.0.1:18095:127.0.0.1:18095 server94 2>&1 | Add-Content $log
    "$(Get-Date -Format s) tunnel dropped (exit $LASTEXITCODE), reconnecting in 3s" | Add-Content $log
    Start-Sleep -Seconds 3
}
