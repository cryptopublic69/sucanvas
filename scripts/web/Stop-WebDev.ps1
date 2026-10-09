$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../..')).Path
$recordPath = Join-Path $repoRoot '.web-dev/dev.pid.json'
if (-not (Test-Path -LiteralPath $recordPath)) { throw 'No managed Web development server was found.' }
$record = Get-Content -LiteralPath $recordPath -Encoding UTF8 -Raw | ConvertFrom-Json
$process = Get-Process -Id $record.processId -ErrorAction SilentlyContinue
if ($process) {
    if ($process.Path -ne $record.executable -or $process.StartTime.ToUniversalTime().ToString('o') -ne $record.startedAt) { throw 'The saved PID belongs to another process; it will not be stopped.' }
    if ($record.managedBackend) {
        'stop' | Set-Content -LiteralPath (Join-Path $repoRoot '.web-dev/dev-stop.request') -Encoding UTF8
        if (-not $process.WaitForExit(20000)) { throw 'Development is still stopping; inspect its logs. No unrelated processes were killed.' }
    } else {
        # Compatibility with the earlier frontend-only development launcher.
        Stop-Process -Id $process.Id
        $process.WaitForExit()
    }
}
Remove-Item -LiteralPath $recordPath
Write-Host 'Local Web development stopped.'
