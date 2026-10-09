param([switch]$Foreground)
$ErrorActionPreference = 'Stop'
$deploymentRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$serverExe = Join-Path $deploymentRoot 'SuCanvasServer.exe'
$configPath = Join-Path $deploymentRoot 'config.json'
if (-not (Test-Path -LiteralPath $serverExe)) { throw 'SuCanvasServer.exe is missing. Run Build-Web.ps1 first.' }
if ($Foreground) { & $serverExe --config $configPath; exit $LASTEXITCODE }
$pidPath = Join-Path $deploymentRoot 'server.pid'
if (Test-Path -LiteralPath $pidPath) {
    $record = Get-Content -LiteralPath $pidPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $existing = Get-Process -Id $record.processId -ErrorAction SilentlyContinue
    if ($existing -and $existing.Path -eq $serverExe) { throw 'This deployment is already running.' }
}
$logRoot = Join-Path $deploymentRoot 'logs'
New-Item -ItemType Directory -Path $logRoot -Force | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$process = Start-Process -FilePath $serverExe -ArgumentList @('--config', ('"{0}"' -f $configPath)) -WorkingDirectory $deploymentRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $logRoot "$stamp.out.log") -RedirectStandardError (Join-Path $logRoot "$stamp.err.log") -PassThru
Start-Sleep -Milliseconds 500
if ($process.HasExited) { throw "Server stopped during startup. Read logs/$stamp.err.log." }
@{ processId = $process.Id; startedAt = $process.StartTime.ToUniversalTime().ToString('o') } | ConvertTo-Json | Set-Content -LiteralPath $pidPath -Encoding UTF8
Write-Host "SuCanvas Web started. PID: $($process.Id). Logs: $logRoot"
