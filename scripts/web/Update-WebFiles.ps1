param([Parameter(Mandatory=$true)][string]$PackageDirectory, [string]$DeploymentDirectory, [string]$PublicUrl, [switch]$FrontendOnly, [switch]$RequireLocalDisk)
$ErrorActionPreference = 'Stop'
if (-not $DeploymentDirectory) { $DeploymentDirectory = Join-Path $PSScriptRoot '..' }
$target = (Resolve-Path -LiteralPath $DeploymentDirectory).Path
$package = (Resolve-Path -LiteralPath $PackageDirectory).Path
if ($RequireLocalDisk) {
    foreach ($localPath in @($target, $package, $PSScriptRoot)) {
        if ($localPath.StartsWith('\\') -or ([IO.DriveInfo]::new([IO.Path]::GetPathRoot($localPath))).DriveType -ne [IO.DriveType]::Fixed) {
            throw 'Run the updater on the server using local disk paths, not UNC or mapped network drives.'
        }
    }
}
if ($package -eq $target -or $package.StartsWith($target+'\',[StringComparison]::OrdinalIgnoreCase)) { throw 'Use a package directory outside the deployment.' }
& (Join-Path $PSScriptRoot 'Test-WebDeployment.ps1') -DeploymentDirectory $package
$config = Get-Content -LiteralPath (Join-Path $target 'config.json') -Encoding UTF8 -Raw | ConvertFrom-Json
if ($PublicUrl -and ([Uri]$PublicUrl).GetLeftPart([UriPartial]::Authority) -ne ([Uri]$config.publicUrl).GetLeftPart([UriPartial]::Authority)) { throw 'Configure the intended publicUrl before updating.' }
if ([IO.Path]::IsPathRooted($config.dataDirectory) -or $config.dataDirectory -match '\.\.') { throw 'Portable updates require a relative dataDirectory inside the deployment.' }
if ($config.webDirectory -ne 'web') { throw 'Portable updates require webDirectory to be web.' }
$files = @('build-info.json','web-assets.json')
$directories = @('web')
if (-not $FrontendOnly) {
    $files += @('SuCanvasServer.exe')
    $files += @(Get-ChildItem -LiteralPath $package -File -Filter '*.md' | ForEach-Object { $_.Name })
    $directories += @('scripts','workflows')
}
foreach ($directory in $directories) {
    $files += @(Get-ChildItem -LiteralPath (Join-Path $package $directory) -Recurse -File | ForEach-Object { $_.FullName.Substring($package.Length+1) })
}
# Reject linked paths before recursive backup or publication.
foreach ($root in @($target, $package)) {
    $pending = [Collections.Generic.Stack[string]]::new()
    $pending.Push($root)
    while ($pending.Count) {
        $item = Get-Item -LiteralPath $pending.Pop() -Force
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Update paths must not contain links or junctions.' }
        if ($item.PSIsContainer) {
            foreach ($child in (Get-ChildItem -LiteralPath $item.FullName -Force)) {
                if ($item.FullName -eq $target -and $child.Name -in @('backup','server.lock')) { continue }
                $pending.Push($child.FullName)
            }
        }
    }
}
$backupParent = [IO.Path]::GetFullPath((Join-Path $target 'backup'))
if (Test-Path -LiteralPath $backupParent) { if ((Get-Item -LiteralPath $backupParent -Force).LinkType) { throw 'Backup directory must not be a link.' } }
$backup = Join-Path $backupParent ('before-update-'+(Get-Date -Format 'yyyyMMdd-HHmmss')+'-'+[Guid]::NewGuid().ToString('N').Substring(0,8))
if (-not $backup.StartsWith($target+'\backup\',[StringComparison]::OrdinalIgnoreCase)) { throw 'Invalid backup target.' }
$configHash = (Get-FileHash -LiteralPath (Join-Path $target 'config.json')).Hash
$lock = [IO.File]::Open((Join-Path $target 'server.lock'),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
$started = $false
$newFiles = @()
try {
    $lock.Lock(0,1)
    $exe = [IO.File]::Open((Join-Path $target 'SuCanvasServer.exe'),[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
    $exe.Dispose()
    New-Item -ItemType Directory -Path $backup | Out-Null
    # Do not recursively include backups or copy the lock held by this script.
    $originalFiles = @(Get-ChildItem -LiteralPath $target -Force | Where-Object { $_.Name -notin @('backup','server.lock') } | ForEach-Object {
        if ($_.PSIsContainer) { Get-ChildItem -LiteralPath $_.FullName -Recurse -File -Force } else { $_ }
    })
    Get-ChildItem -LiteralPath $target -Force | Where-Object { $_.Name -notin @('backup','server.lock') } | ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination $backup -Recurse -Force }
    if (@(Get-ChildItem -LiteralPath $backup -Recurse -File -Force).Count -ne $originalFiles.Count) { throw 'Backup file count differs from original deployment.' }
    $retained = @()
    foreach ($oldFile in (Get-ChildItem -LiteralPath $backup -Recurse -File -Force)) {
        $relative = $oldFile.FullName.Substring($backup.Length+1)
        $backupHash = (Get-FileHash -LiteralPath $oldFile.FullName -Algorithm SHA256).Hash
        if ($backupHash -ne (Get-FileHash -LiteralPath (Join-Path $target $relative) -Algorithm SHA256).Hash) { throw "Backup mismatch: $relative" }
        if ($relative -notin $files) { $retained += [PSCustomObject]@{ path = $relative; sha256 = $backupHash } }
    }
    Write-Host "Backup verified: $backup"
    $started = $true
    # Publish the HTML last; existing asset versions remain available.
    foreach ($relative in ($files | Where-Object { $_ -ne 'web\index.html' })) {
        $destination = Join-Path $target $relative
        if ($relative.StartsWith('web\assets\') -and (Test-Path -LiteralPath $destination) -and
            (Get-FileHash -LiteralPath $destination).Hash -ne (Get-FileHash -LiteralPath (Join-Path $package $relative)).Hash) { throw "Versioned asset collision: $relative" }
        if (-not (Test-Path -LiteralPath $destination)) { $newFiles += $relative }
        New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force | Out-Null
        Copy-Item -LiteralPath (Join-Path $package $relative) -Destination $destination -Force
    }
    $indexStage = Join-Path $target 'web/index.update-new'
    Copy-Item -LiteralPath (Join-Path $package 'web/index.html') -Destination $indexStage
    [IO.File]::Replace($indexStage,(Join-Path $target 'web/index.html'),(Join-Path $backup 'index.before-replace.html'))
    foreach ($relative in $files) { if ((Get-FileHash -LiteralPath (Join-Path $package $relative)).Hash -ne (Get-FileHash -LiteralPath (Join-Path $target $relative)).Hash) { throw "Updated file mismatch: $relative" } }
    if ((Get-FileHash -LiteralPath (Join-Path $target 'config.json')).Hash -ne $configHash) { throw 'Configuration changed during update.' }
    & (Join-Path $PSScriptRoot 'Test-WebDeployment.ps1') -DeploymentDirectory $target -PublicUrl $PublicUrl
    foreach ($record in $retained) {
        if ((Get-FileHash -LiteralPath (Join-Path $target $record.path) -Algorithm SHA256).Hash -ne $record.sha256) { throw "Retained file changed: $($record.path)" }
    }
    [PSCustomObject]@{ Succeeded = $true; CompletedAt = [DateTime]::UtcNow.ToString('o'); Backup = $backup; RetainedFiles = $retained.Count; PublishedFiles = $files.Count; FrontendOnly = [bool]$FrontendOnly; ServerRestarted = $false } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $backup 'update-result.json') -Encoding UTF8
    Write-Host "Files updated. Backup: $backup"
    Write-Host 'Start the backend and proxy with your service switch, then run Test-WebDeployment.ps1 -CheckHttp.'
} catch {
    if ($started) {
        foreach ($relative in $files) {
            $oldFile = Join-Path $backup $relative
            if (Test-Path -LiteralPath $oldFile -PathType Leaf) { Copy-Item -LiteralPath $oldFile -Destination (Join-Path $target $relative) -Force }
        }
        foreach ($relative in $newFiles) {
            $newFile = [IO.Path]::GetFullPath((Join-Path $target $relative))
            if (-not $newFile.StartsWith($target+'\',[StringComparison]::OrdinalIgnoreCase)) { throw 'Invalid rollback file path.' }
            if (Test-Path -LiteralPath $newFile -PathType Leaf) { Remove-Item -LiteralPath $newFile -Force }
        }
        Write-Host 'Update failed; previous published files restored. The backup is retained.'
    }
    throw
} finally { $lock.Dispose() }
