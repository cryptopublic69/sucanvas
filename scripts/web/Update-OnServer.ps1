param([string]$PackageDirectory, [string]$DeploymentDirectory = 'F:\SuCanvas-Web')
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$OutputEncoding = [Text.Encoding]::UTF8
if (-not $PackageDirectory) { $PackageDirectory = Join-Path $PSScriptRoot 'package' }
foreach ($localPath in @($PSScriptRoot, $PackageDirectory, $DeploymentDirectory)) {
    $absolute = [IO.Path]::GetFullPath($localPath)
    if ($absolute.StartsWith('\\') -or ([IO.DriveInfo]::new([IO.Path]::GetPathRoot($absolute))).DriveType -ne [IO.DriveType]::Fixed) {
        throw 'Run this script on 108 using its local F: drive. Do not launch it through a network share.'
    }
}
if (-not (Test-Path -LiteralPath (Join-Path $PackageDirectory 'web-assets.json') -PathType Leaf)) {
    throw 'No update package is ready. Upload the new release into the package folder first.'
}
$logRoot = Join-Path $PSScriptRoot 'logs'
New-Item -ItemType Directory -Path $logRoot -Force | Out-Null
$log = Join-Path $logRoot ('update-'+(Get-Date -Format 'yyyyMMdd-HHmmss')+'-'+[Guid]::NewGuid().ToString('N').Substring(0,8)+'.log')
Start-Transcript -LiteralPath $log | Out-Null
try {
    Write-Host 'SuCanvas update on local server disk. Stop the service with your existing switch first.'
    $frontendOnly = -not (Test-Path -LiteralPath (Join-Path $PackageDirectory 'SuCanvasServer.exe') -PathType Leaf)
    Write-Host ('Update mode: '+$(if ($frontendOnly) { 'Web frontend' } else { 'Web frontend and server' }))
    & (Join-Path $PSScriptRoot 'scripts/Update-WebFiles.ps1') -PackageDirectory $PackageDirectory -DeploymentDirectory $DeploymentDirectory -FrontendOnly:$frontendOnly -RequireLocalDisk
    $build = Get-Content -LiteralPath (Join-Path $DeploymentDirectory 'build-info.json') -Encoding UTF8 -Raw | ConvertFrom-Json
    [PSCustomObject]@{ Succeeded = $true; CompletedAt = [DateTime]::UtcNow.ToString('o'); AssetVersion = $build.assetVersion; FrontendOnly = $frontendOnly; Log = $log; ServerRestarted = $false } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $PSScriptRoot 'deployment-result.json') -Encoding UTF8
    Write-Host ('PASS: version '+$build.assetVersion+'. Start the service with your existing switch, then refresh the webpage.')
} catch {
    [PSCustomObject]@{ Succeeded = $false; Error = $_.Exception.Message; Log = $log; ServerRestarted = $false } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $PSScriptRoot 'deployment-result.json') -Encoding UTF8
    Write-Host 'FAILED: update did not complete. Keep the service stopped and check this log:'
    Write-Host $log
    throw
} finally { Stop-Transcript | Out-Null }
