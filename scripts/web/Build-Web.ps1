param([string]$OutputDirectory, [string]$FfmpegPath)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../..')).Path
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $repoRoot 'release-web/SuCanvas-Web' }
$OutputDirectory = [IO.Path]::GetFullPath($OutputDirectory)
if (Test-Path -LiteralPath (Join-Path $OutputDirectory 'server.pid')) { throw 'Stop the deployment before rebuilding its files.' }
$cargoCommand = Get-Command cargo.exe -ErrorAction SilentlyContinue
$cargoPath = if ($cargoCommand) { $cargoCommand.Source } else { Join-Path $env:USERPROFILE '.cargo/bin/cargo.exe' }
if (-not (Test-Path -LiteralPath $cargoPath)) { throw 'Cargo is required only on the build machine.' }
if (-not $FfmpegPath) {
    $ffmpegCommand = Get-Command ffmpeg.exe -ErrorAction SilentlyContinue
    if ($ffmpegCommand) { $FfmpegPath = $ffmpegCommand.Source }
}
if (-not $FfmpegPath -or -not (Test-Path -LiteralPath $FfmpegPath)) { throw 'Provide -FfmpegPath to include FFmpeg in the portable package.' }
Push-Location $repoRoot
$previousRustFlags = $env:RUSTFLAGS
try {
    if (-not (Test-Path -LiteralPath 'node_modules')) { & npm.cmd ci; if ($LASTEXITCODE) { throw 'npm ci failed' } }
    & npm.cmd run build:web
    if ($LASTEXITCODE) { throw 'Web build failed' }
    # Bundle the C runtime into the server executable for Windows portability.
    $env:RUSTFLAGS = "$previousRustFlags -C target-feature=+crt-static".Trim()
    & $cargoPath build --manifest-path src-tauri/Cargo.toml --no-default-features --features server --bin SuCanvasServer --release --locked
    if ($LASTEXITCODE) { throw 'Server build failed' }
    foreach ($directory in @($OutputDirectory, (Join-Path $OutputDirectory 'web'), (Join-Path $OutputDirectory 'scripts'), (Join-Path $OutputDirectory 'tools'))) {
        New-Item -ItemType Directory -Path $directory -Force | Out-Null
    }
    Copy-Item -LiteralPath 'src-tauri/target/release/SuCanvasServer.exe' -Destination $OutputDirectory -Force
    # A new package uses an empty data directory. Updating keeps its settings.
    Copy-Item -Path 'dist-web/*' -Destination (Join-Path $OutputDirectory 'web') -Recurse -Force
    Copy-Item -LiteralPath 'workflows' -Destination $OutputDirectory -Recurse -Force
    foreach ($script in @('Start-Web.ps1', 'Stop-Web.ps1', 'Set-Password.ps1', 'Backup-Web.ps1', 'Restore-Web.ps1', 'Install-Autostart.ps1')) {
        Copy-Item -LiteralPath (Join-Path $PSScriptRoot $script) -Destination (Join-Path $OutputDirectory 'scripts') -Force
    }
    Copy-Item -LiteralPath $FfmpegPath -Destination (Join-Path $OutputDirectory 'tools/ffmpeg.exe') -Force
    $ffmpegRoot = Split-Path -Parent (Split-Path -Parent $FfmpegPath)
    foreach ($notice in @('LICENSE', 'README.txt')) {
        $noticePath = Join-Path $ffmpegRoot $notice
        if (Test-Path -LiteralPath $noticePath -PathType Leaf) {
            Copy-Item -LiteralPath $noticePath -Destination (Join-Path $OutputDirectory "tools/FFmpeg-$notice") -Force
        }
    }
    Get-ChildItem -LiteralPath (Split-Path -Parent $FfmpegPath) -Filter '*.dll' -File | ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $OutputDirectory 'tools') -Force }
    if (-not (Test-Path -LiteralPath (Join-Path $OutputDirectory 'config.json'))) {
        Copy-Item -LiteralPath 'deploy/windows/config.example.json' -Destination (Join-Path $OutputDirectory 'config.json')
    }
    Copy-Item -LiteralPath 'deploy/windows/README.md' -Destination (Join-Path $OutputDirectory 'README.md') -Force
    Copy-Item -LiteralPath 'deploy/windows/VALIDATION.md' -Destination (Join-Path $OutputDirectory 'VALIDATION.md') -Force
    $revision = (& git rev-parse HEAD).Trim()
    @{ builtAt = [DateTime]::UtcNow.ToString('o'); sourceRevision = $revision; platform = 'windows-x64'; dirtySource = [bool](& git status --porcelain) } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $OutputDirectory 'build-info.json') -Encoding UTF8
    Write-Host "Portable package: $OutputDirectory"
} finally { $env:RUSTFLAGS = $previousRustFlags; Pop-Location }
