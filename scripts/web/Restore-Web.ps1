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
if ($backupRoot.StartsWith($deploymentRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase) -or $backupRoot -eq $deploymentRoot) { throw 'The backup must be outside the deployment directory.' }
if ((Test-Path -LiteralPath $targetData) -and (Get-Item -LiteralPath $targetData -Force).LinkType) { throw 'Restore does not replace a linked data directory.' }
$lock = [IO.File]::Open((Join-Path $deploymentRoot 'server.lock'), [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
$staging = $targetData + '.restore-' + [Guid]::NewGuid().ToString('N')
$previous = $null
try {
    Copy-Item -LiteralPath (Join-Path $backupRoot 'data') -Destination $staging -Recurse
    if (Test-Path -LiteralPath $targetData) {
        $previous = $targetData + '.before-restore-' + [Guid]::NewGuid().ToString('N')
        Move-Item -LiteralPath $targetData -Destination $previous
    }
    try { Move-Item -LiteralPath $staging -Destination $targetData } catch {
        if ($previous -and -not (Test-Path -LiteralPath $targetData)) { Move-Item -LiteralPath $previous -Destination $targetData }
        throw
    }
} finally { $lock.Dispose() }
Write-Host 'Data restored. Existing deployment configuration was kept; review its domain and ComfyUI settings before starting.'
