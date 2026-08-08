[CmdletBinding()]
param(
    [switch]$Check
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$cargoBin = Join-Path $env:USERPROFILE '.cargo\bin'
$vitePort = 1420
$previousLocation = Get-Location
$transcriptStarted = $false

function Get-RequiredCommand {
    param([Parameter(Mandatory = $true)][string]$Name)

    $command = Get-Command $Name -ErrorAction SilentlyContinue
    if (-not $command) {
        throw "Required command was not found: $Name"
    }
    $command
}

function Get-PortOwner {
    param([Parameter(Mandatory = $true)][int]$Port)

    $listener = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if (-not $listener) {
        return $null
    }

    Get-CimInstance Win32_Process -Filter "ProcessId=$($listener.OwningProcess)" -ErrorAction SilentlyContinue
}

try {
    if (Test-Path -LiteralPath (Join-Path $cargoBin 'cargo.exe')) {
        $env:PATH = "$cargoBin;$env:PATH"
    }

    Set-Location -LiteralPath $projectRoot
    $node = Get-RequiredCommand 'node.exe'
    $npm = Get-RequiredCommand 'npm.cmd'
    $cargo = Get-RequiredCommand 'cargo.exe'

    $dataDir = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'InfiniteCanvas'
    [void](New-Item -ItemType Directory -Path $dataDir -Force)
    $logPath = Join-Path $dataDir 'dev-launcher.log'
    try {
        Start-Transcript -LiteralPath $logPath -Append | Out-Null
        $transcriptStarted = $true
    }
    catch {
        Write-Warning "Could not start launcher log: $($_.Exception.Message)"
    }

    Write-Host ''
    Write-Host 'InfiniteCanvas development preview' -ForegroundColor Cyan
    Write-Host "Project: $projectRoot"
    Write-Host "Log:     $logPath"
    Write-Host ''

    if ($Check) {
        Write-Host "Node:  $(& $node.Source --version)"
        Write-Host "npm:   $(& $npm.Source --version)"
        Write-Host "Cargo: $(& $cargo.Source --version)"

        $owner = Get-PortOwner $vitePort
        if ($owner) {
            Write-Host "Port ${vitePort}: listening (PID $($owner.ProcessId), $($owner.Name))"
        }
        else {
            Write-Host "Port ${vitePort}: available"
        }
        exit 0
    }

    $owner = Get-PortOwner $vitePort
    if ($owner) {
        $ownerCommandLine = [string]$owner.CommandLine
        if ($ownerCommandLine.IndexOf($projectRoot, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
            Write-Host "InfiniteCanvas dev preview is already running on http://localhost:$vitePort" -ForegroundColor Green
            Write-Host "PID: $($owner.ProcessId)"
            exit 0
        }

        throw "Port $vitePort is already used by PID $($owner.ProcessId) ($($owner.Name)). Close that process or change the Vite port."
    }

    if (-not (Test-Path -LiteralPath (Join-Path $projectRoot 'node_modules\.bin\vite.cmd'))) {
        Write-Host 'Installing npm dependencies...' -ForegroundColor Yellow
        & $npm.Source install
        if ($LASTEXITCODE -ne 0) {
            throw "npm install failed with exit code $LASTEXITCODE"
        }
    }

    Write-Host 'Starting Tauri 2 + Vite hot reload...' -ForegroundColor Green
    Write-Host 'React/CSS changes refresh immediately; Rust changes trigger an incremental rebuild.'
    Write-Host 'Press Ctrl+C in this window to stop the development preview.'
    Write-Host ''

    & $npm.Source run tauri dev
    exit $LASTEXITCODE
}
catch {
    Write-Host ''
    Write-Host "DEV START FAILED: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}
finally {
    if ($transcriptStarted) {
        try { Stop-Transcript | Out-Null } catch {}
    }
    Set-Location -LiteralPath $previousLocation
}
