param([Parameter(Mandatory = $true)][string]$BackupDirectory)
$ErrorActionPreference = 'Stop'
$deploymentRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$backupRoot = (Resolve-Path -LiteralPath $BackupDirectory).Path
$running = Get-Process -Name SuCanvasServer -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq (Join-Path $deploymentRoot 'SuCanvasServer.exe') }
if ($running) { throw 'Stop this deployment before restoring.' }
if (-not (Test-Path -LiteralPath (Join-Path $backupRoot 'data/infinite-canvas.sqlite3'))) { throw 'The backup is missing its database.' }
$config = Get-Content -LiteralPath (Join-Path $deploymentRoot 'config.json') -Encoding UTF8 -Raw | ConvertFrom-Json
$targetData = [IO.Path]::GetFullPath((Join-Path $deploymentRoot $config.dataDirectory))
if ([IO.Path]::IsPathRooted($config.dataDirectory) -or -not $targetData.StartsWith($deploymentRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Restore requires a relative dataDirectory inside this deployment.' }
$backupParent = [IO.Path]::GetFullPath((Join-Path $deploymentRoot 'backup'))
if (-not $backupRoot.StartsWith($backupParent+'\',[StringComparison]::OrdinalIgnoreCase)) { throw 'Restore from a directory under this deployment backup directory.' }
if ((Get-Item -LiteralPath $backupParent -Force).LinkType) { throw 'Backup directory must not be a link.' }
if ((Test-Path -LiteralPath $targetData) -and (Get-Item -LiteralPath $targetData -Force).LinkType) { throw 'Restore does not replace a linked data directory.' }
$lock = [IO.File]::Open((Join-Path $deploymentRoot 'server.lock'), [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
$staging = $targetData + '.restore-' + [Guid]::NewGuid().ToString('N')
$previous = $null
try {
    $lock.Lock(0,1)
    Copy-Item -LiteralPath (Join-Path $backupRoot 'data') -Destination $staging -Recurse
    if (Test-Path -LiteralPath $targetData) {
        $previous = [IO.Path]::GetFullPath((Join-Path $backupParent ('data-before-restore-' + [Guid]::NewGuid().ToString('N'))))
        if (-not $previous.StartsWith($backupParent+'\',[StringComparison]::OrdinalIgnoreCase) -or -not $staging.StartsWith($deploymentRoot+'\',[StringComparison]::OrdinalIgnoreCase)) { throw 'Invalid restore paths.' }
        Move-Item -LiteralPath $targetData -Destination $previous
    }
    try { Move-Item -LiteralPath $staging -Destination $targetData } catch {
        if ($previous -and -not (Test-Path -LiteralPath $targetData)) { Move-Item -LiteralPath $previous -Destination $targetData }
        throw
    }
} finally { $lock.Dispose() }
Write-Host 'Data restored. Existing deployment configuration was kept; review its domain and ComfyUI settings before starting.'
