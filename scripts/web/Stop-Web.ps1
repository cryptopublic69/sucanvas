$ErrorActionPreference = 'Stop'
$deploymentRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$pidPath = Join-Path $deploymentRoot 'server.pid'
if (-not (Test-Path -LiteralPath $pidPath)) { throw 'No managed server.pid was found. Stop a foreground or scheduled server from its owning process/task.' }
$record = Get-Content -LiteralPath $pidPath -Raw -Encoding UTF8 | ConvertFrom-Json
$process = Get-Process -Id $record.processId -ErrorAction SilentlyContinue
if ($process) {
    $expectedExe = Join-Path $deploymentRoot 'SuCanvasServer.exe'
    if ($process.Path -ne $expectedExe -or $process.StartTime.ToUniversalTime().ToString('o') -ne $record.startedAt) { throw 'The saved PID belongs to another process; it will not be stopped.' }
    Stop-Process -Id $process.Id
    $process.WaitForExit()
}
Remove-Item -LiteralPath $pidPath
Write-Host 'SuCanvas Web stopped.'
