param([Parameter(Mandatory=$true)][string]$PackageDirectory, [string]$DeploymentDirectory, [string]$PublicUrl)
$ErrorActionPreference = 'Stop'
if (-not $DeploymentDirectory) { $DeploymentDirectory = Join-Path $PSScriptRoot '..' }
$target = (Resolve-Path -LiteralPath $DeploymentDirectory).Path
$package = (Resolve-Path -LiteralPath $PackageDirectory).Path
if ($package -eq $target -or $package.StartsWith($target+'\',[StringComparison]::OrdinalIgnoreCase)) { throw 'Use a package directory outside the deployment.' }
& (Join-Path $package 'scripts/Test-WebDeployment.ps1') -DeploymentDirectory $package
$config = Get-Content -LiteralPath (Join-Path $target 'config.json') -Encoding UTF8 -Raw | ConvertFrom-Json
if ($PublicUrl -and ([Uri]$PublicUrl).GetLeftPart([UriPartial]::Authority) -ne ([Uri]$config.publicUrl).GetLeftPart([UriPartial]::Authority)) { throw 'Configure the intended publicUrl before updating.' }
if ([IO.Path]::IsPathRooted($config.dataDirectory) -or $config.dataDirectory -match '\.\.') { throw 'Portable updates require a relative dataDirectory inside the deployment.' }
if ($config.webDirectory -ne 'web') { throw 'Portable updates require webDirectory to be web.' }
$files = @('SuCanvasServer.exe','build-info.json','web-assets.json')
$files += @(Get-ChildItem -LiteralPath $package -File -Filter '*.md' | ForEach-Object { $_.Name })
foreach ($directory in @('web','scripts','workflows')) {
    $files += @(Get-ChildItem -LiteralPath (Join-Path $package $directory) -Recurse -File | ForEach-Object { $_.FullName.Substring($package.Length+1) })
}
$backupParent = [IO.Path]::GetFullPath((Join-Path $target 'backup'))
if (Test-Path -LiteralPath $backupParent) { if ((Get-Item -LiteralPath $backupParent -Force).LinkType) { throw 'Backup directory must not be a link.' } }
$backup = Join-Path $backupParent ('before-update-'+(Get-Date -Format 'yyyyMMdd-HHmmss')+'-'+[Guid]::NewGuid().ToString('N').Substring(0,8))
if (-not $backup.StartsWith($target+'\backup\',[StringComparison]::OrdinalIgnoreCase)) { throw 'Invalid backup target.' }
$configHash = (Get-FileHash -LiteralPath (Join-Path $target 'config.json')).Hash
$lock = [IO.File]::Open((Join-Path $target 'server.lock'),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
$started = $false
try {
    $lock.Lock(0,1)
    $exe = [IO.File]::Open((Join-Path $target 'SuCanvasServer.exe'),[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
    $exe.Dispose()
    New-Item -ItemType Directory -Path $backup | Out-Null
    # Do not recursively include backups or copy the lock held by this script.
    Get-ChildItem -LiteralPath $target -Force | Where-Object { $_.Name -notin @('backup','server.lock') } | ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination $backup -Recurse }
    foreach ($oldFile in (Get-ChildItem -LiteralPath $backup -Recurse -File)) {
        $relative = $oldFile.FullName.Substring($backup.Length+1)
        if ((Get-FileHash -LiteralPath $oldFile.FullName).Hash -ne (Get-FileHash -LiteralPath (Join-Path $target $relative)).Hash) { throw "Backup mismatch: $relative" }
    }
    $started = $true
    # Publish the HTML last; existing asset versions remain available.
    foreach ($relative in ($files | Where-Object { $_ -ne 'web\index.html' })) {
        $destination = Join-Path $target $relative
        New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force | Out-Null
        Copy-Item -LiteralPath (Join-Path $package $relative) -Destination $destination -Force
    }
    $indexStage = Join-Path $target 'web/index.update-new'
    Copy-Item -LiteralPath (Join-Path $package 'web/index.html') -Destination $indexStage
    [IO.File]::Replace($indexStage,(Join-Path $target 'web/index.html'),(Join-Path $backup 'index.before-replace.html'))
    foreach ($relative in $files) { if ((Get-FileHash -LiteralPath (Join-Path $package $relative)).Hash -ne (Get-FileHash -LiteralPath (Join-Path $target $relative)).Hash) { throw "Updated file mismatch: $relative" } }
    if ((Get-FileHash -LiteralPath (Join-Path $target 'config.json')).Hash -ne $configHash) { throw 'Configuration changed during update.' }
    & (Join-Path $package 'scripts/Test-WebDeployment.ps1') -DeploymentDirectory $target -PublicUrl $PublicUrl
    Write-Host "Files updated. Backup: $backup"
    Write-Host 'Start the backend and proxy with your service switch, then run Test-WebDeployment.ps1 -CheckHttp.'
} catch {
    if ($started) {
        foreach ($relative in $files) {
            $oldFile = Join-Path $backup $relative
            if (Test-Path -LiteralPath $oldFile -PathType Leaf) { Copy-Item -LiteralPath $oldFile -Destination (Join-Path $target $relative) -Force }
        }
        Write-Host 'Update failed; previous published files restored. The backup is retained.'
    }
    throw
} finally { $lock.Dispose() }
