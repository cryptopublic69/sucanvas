param(
    [string]$DeploymentDirectory,
    [string]$CredentialsFile,
    [string]$FfmpegPath,
    [ValidateRange(1024, 65535)][int]$Port = 1422,
    [ValidateRange(1024, 65535)][int]$BackendPort = 18742,
    [switch]$Foreground
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../..')).Path
if ($Port -eq $BackendPort) { throw 'Frontend and backend must use different ports.' }
$nodeExe = (Get-Command node.exe -ErrorAction Stop).Source
if (-not (Test-Path -LiteralPath (Join-Path $repoRoot 'node_modules/vite/bin/vite.js'))) { throw 'Run npm ci in this Web source directory first.' }
$cargo = Get-Command cargo.exe -ErrorAction SilentlyContinue
$cargoExe = if ($cargo) { $cargo.Source } else { Join-Path $env:USERPROFILE '.cargo/bin/cargo.exe' }
if (-not (Test-Path -LiteralPath $cargoExe)) { throw 'Install Rust and Visual Studio C++ Build Tools on the development machine.' }
$devRoot = Join-Path $repoRoot '.web-dev'
$runtime = Join-Path $devRoot 'runtime'
$recordPath = Join-Path $devRoot 'dev.pid.json'
if (Test-Path -LiteralPath $recordPath) {
    $record = Get-Content -LiteralPath $recordPath -Encoding UTF8 -Raw | ConvertFrom-Json
    $existing = Get-Process -Id $record.processId -ErrorAction SilentlyContinue
    if ($existing -and $existing.Path -eq $record.executable -and $existing.StartTime.ToUniversalTime().ToString('o') -eq $record.startedAt) { throw 'Development is already running. Use Stop-WebDev.ps1 first.' }
}
$deployment = $null
if ($DeploymentDirectory) {
    $deploymentRoot = (Resolve-Path -LiteralPath $DeploymentDirectory).Path
    $deployment = Get-Content -LiteralPath (Join-Path $deploymentRoot 'config.json') -Encoding UTF8 -Raw | ConvertFrom-Json
    if (-not $CredentialsFile) {
        $dataRoot = if ([IO.Path]::IsPathRooted($deployment.dataDirectory)) { $deployment.dataDirectory } else { Join-Path $deploymentRoot $deployment.dataDirectory }
        $CredentialsFile = Join-Path $dataRoot 'web-auth.json'
    }
}
foreach ($directory in @($runtime, (Join-Path $runtime 'data'), (Join-Path $runtime 'web'))) { New-Item -ItemType Directory -Path $directory -Force | Out-Null }
$configPath = Join-Path $runtime 'config.json'
$backendUrl = "http://127.0.0.1:$BackendPort"
if (-not (Test-Path -LiteralPath $configPath)) {
    $localConfig = [ordered]@{
        listen = "127.0.0.1:$BackendPort"; publicUrl = $backendUrl
        dataDirectory = 'data'; webDirectory = 'web'; downloadsDirectory = 'downloads'
        comfyUrl = $(if ($deployment) { $deployment.comfyUrl } else { 'http://127.0.0.1:8188' })
        comfyInputDirectory = ''; comfyOutputDirectory = ''; maxUploadBytes = 1073741824
    }
    [IO.File]::WriteAllText($configPath, ($localConfig | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
} else {
    $configuration = Get-Content -LiteralPath $configPath -Encoding UTF8 -Raw | ConvertFrom-Json
    if ($configuration.listen -ne "127.0.0.1:$BackendPort" -or $configuration.publicUrl -ne $backendUrl -or $configuration.dataDirectory -ne 'data') { throw 'Existing local config differs from the requested port or data directory. Adjust it deliberately before restarting.' }
}
$authPath = Join-Path $runtime 'data/web-auth.json'
if (-not (Test-Path -LiteralPath $authPath)) {
    if (-not $CredentialsFile -or -not (Test-Path -LiteralPath $CredentialsFile)) { throw 'For first initialization, provide -DeploymentDirectory or -CredentialsFile to reuse an existing login password hash.' }
    Copy-Item -LiteralPath $CredentialsFile -Destination $authPath
}
# Browsers use Vite. This private backend placeholder satisfies its startup check.
'<!doctype html><title>SuCanvas local development backend</title>' | Set-Content -LiteralPath (Join-Path $runtime 'web/index.html') -Encoding UTF8
$workflowLink = Join-Path $runtime 'workflows'
if (-not (Test-Path -LiteralPath $workflowLink)) { New-Item -ItemType Junction -Path $workflowLink -Target (Join-Path $repoRoot 'workflows') | Out-Null }
if (-not $FfmpegPath) {
    $bundled = Join-Path $repoRoot 'release-web/SuCanvas-Web/tools/ffmpeg.exe'
    $ffmpeg = Get-Command ffmpeg.exe -ErrorAction SilentlyContinue
    if (Test-Path -LiteralPath $bundled) { $FfmpegPath = $bundled } elseif ($ffmpeg) { $FfmpegPath = $ffmpeg.Source }
}
if (-not $FfmpegPath -or -not (Test-Path -LiteralPath $FfmpegPath)) { throw 'Provide -FfmpegPath for local video thumbnail support.' }
@{
    cargo = $cargoExe; runtime = $runtime; target = (Join-Path $repoRoot 'src-tauri/target')
    frontendPort = $Port; backendPort = $BackendPort; frontendUrl = "http://127.0.0.1:$Port"
    tools = (Split-Path -Parent ([IO.Path]::GetFullPath($FfmpegPath)))
} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $devRoot 'dev-config.json') -Encoding UTF8
foreach ($name in @('dev-stop.request', 'dev-status.json')) {
    $item = Join-Path $devRoot $name
    if (Test-Path -LiteralPath $item) { Remove-Item -LiteralPath $item }
}
$entry = Join-Path $PSScriptRoot 'dev-server.mjs'
if ($Foreground) {
    & $nodeExe $entry
    if ($LASTEXITCODE) { throw 'Development failed. Read the error above.' }
} else {
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $outLog = Join-Path $devRoot "dev-$stamp.out.log"
    $errLog = Join-Path $devRoot "dev-$stamp.err.log"
    $process = Start-Process -FilePath $nodeExe -ArgumentList ('"{0}"' -f $entry) -WorkingDirectory $repoRoot -WindowStyle Hidden -RedirectStandardOutput $outLog -RedirectStandardError $errLog -PassThru
    @{ processId = $process.Id; executable = $nodeExe; startedAt = $process.StartTime.ToUniversalTime().ToString('o'); url = "http://127.0.0.1:$Port"; backend = $backendUrl; managedBackend = $true; outputLog = $outLog; errorLog = $errLog } | ConvertTo-Json | Set-Content -LiteralPath $recordPath -Encoding UTF8
    Write-Host 'Local frontend/backend starting. The first Rust build may take a few minutes.'
    Write-Host "Open when ready: http://127.0.0.1:$Port"
    Write-Host "Status: $(Join-Path $devRoot 'dev-status.json')"
    Write-Host "Logs: $outLog / $errLog"
}
