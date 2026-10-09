param([string]$Destination)
$ErrorActionPreference = 'Stop'
$deploymentRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$serverExe = Join-Path $deploymentRoot 'SuCanvasServer.exe'
$running = Get-Process -Name SuCanvasServer -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $serverExe }
if ($running) { throw 'Stop this deployment before copying its database and files.' }
$backupRoot = [IO.Path]::GetFullPath((Join-Path $deploymentRoot 'backup'))
if (-not $Destination) { $Destination = Join-Path $backupRoot ('data-'+(Get-Date -Format 'yyyyMMdd-HHmmss')+'-'+[Guid]::NewGuid().ToString('N').Substring(0,8)) }
$destinationPath = [IO.Path]::GetFullPath($Destination)
if (-not $destinationPath.StartsWith($backupRoot + '\',[StringComparison]::OrdinalIgnoreCase)) { throw 'Backups must be stored under this deployment backup directory.' }
if ((Test-Path -LiteralPath $backupRoot) -and (Get-Item -LiteralPath $backupRoot -Force).LinkType) { throw 'Backup directory must not be a link.' }
if (Test-Path -LiteralPath $destinationPath) { throw 'The backup destination must not already exist.' }
$config = Get-Content -LiteralPath (Join-Path $deploymentRoot 'config.json') -Encoding UTF8 -Raw | ConvertFrom-Json
$dataPath = if ([IO.Path]::IsPathRooted($config.dataDirectory)) { $config.dataDirectory } else { Join-Path $deploymentRoot $config.dataDirectory }
if ($destinationPath.StartsWith([IO.Path]::GetFullPath($dataPath)+'\',[StringComparison]::OrdinalIgnoreCase)) { throw 'Backup cannot be inside the active data directory.' }
$lock = [IO.File]::Open((Join-Path $deploymentRoot 'server.lock'), [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
try {
    $lock.Lock(0,1)
    New-Item -ItemType Directory -Path $destinationPath | Out-Null
    Copy-Item -LiteralPath (Join-Path $deploymentRoot 'config.json') -Destination $destinationPath
    Copy-Item -LiteralPath $dataPath -Destination (Join-Path $destinationPath 'data') -Recurse
} finally { $lock.Dispose() }
Write-Host "Backup saved: $destinationPath"
