param([Parameter(Mandatory = $true)][string]$Destination)
$ErrorActionPreference = 'Stop'
$deploymentRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$serverExe = Join-Path $deploymentRoot 'SuCanvasServer.exe'
$running = Get-Process -Name SuCanvasServer -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $serverExe }
if ($running) { throw 'Stop this deployment before copying its database and files.' }
$destinationPath = [IO.Path]::GetFullPath($Destination)
if ($destinationPath.StartsWith($deploymentRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase) -or $destinationPath -eq $deploymentRoot) { throw 'Choose a backup directory outside the deployment.' }
if (Test-Path -LiteralPath $destinationPath) { throw 'The backup destination must not already exist.' }
$config = Get-Content -LiteralPath (Join-Path $deploymentRoot 'config.json') -Encoding UTF8 -Raw | ConvertFrom-Json
New-Item -ItemType Directory -Path $destinationPath | Out-Null
Copy-Item -LiteralPath (Join-Path $deploymentRoot 'config.json') -Destination $destinationPath
$dataPath = if ([IO.Path]::IsPathRooted($config.dataDirectory)) { $config.dataDirectory } else { Join-Path $deploymentRoot $config.dataDirectory }
$lock = [IO.File]::Open((Join-Path $deploymentRoot 'server.lock'), [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
try { Copy-Item -LiteralPath $dataPath -Destination (Join-Path $destinationPath 'data') -Recurse } finally { $lock.Dispose() }
Write-Host "Backup saved: $destinationPath"
