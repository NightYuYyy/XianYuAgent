# Start the solver service and its reverse SSH tunnel as hidden background processes
# that outlive the terminal / Claude session that launched them.
# Usage: powershell -ExecutionPolicy Bypass -File run-detached.ps1
# Stop:  Get-CimInstance Win32_Process | ? { $_.CommandLine -match 'realmouse-solver[\/](service\.py|tunnel\.ps1)' } | % { Stop-Process -Id $_.ProcessId -Force }
$root = $PSScriptRoot
Start-Process -FilePath "powershell.exe" -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $root 'start.ps1')) -WorkingDirectory $root -WindowStyle Hidden
Start-Process -FilePath "powershell.exe" -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $root 'tunnel.ps1')) -WorkingDirectory $root -WindowStyle Hidden
Write-Output "solver + tunnel launched detached"
