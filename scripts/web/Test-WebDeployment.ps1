param([string]$DeploymentDirectory, [string]$PublicUrl, [switch]$CheckHttp)
$ErrorActionPreference = 'Stop'
if (-not $DeploymentDirectory) { $DeploymentDirectory = Join-Path $PSScriptRoot '..' }
$root = (Resolve-Path -LiteralPath $DeploymentDirectory).Path
$config = Get-Content -LiteralPath (Join-Path $root 'config.json') -Encoding UTF8 -Raw | ConvertFrom-Json
$origin = [Uri]$config.publicUrl
if (-not $origin.IsAbsoluteUri -or $origin.AbsolutePath -ne '/' -or $origin.Query -or $origin.Fragment -or $origin.UserInfo) { throw 'publicUrl must be an origin without a subpath.' }
if ($origin.Scheme -ne 'https' -and -not ($origin.Scheme -eq 'http' -and $origin.Host -in @('localhost','127.0.0.1','[::1]'))) { throw 'Public access requires HTTPS.' }
if ($PublicUrl -and ([Uri]$PublicUrl).GetLeftPart([UriPartial]::Authority) -ne $origin.GetLeftPart([UriPartial]::Authority)) { throw 'publicUrl does not match the intended browser address.' }
$web = if ([IO.Path]::IsPathRooted($config.webDirectory)) { $config.webDirectory } else { Join-Path $root $config.webDirectory }
$index = Join-Path $web 'index.html'
$manifest = Get-Content -LiteralPath (Join-Path $root 'web-assets.json') -Encoding UTF8 -Raw | ConvertFrom-Json
if ((Get-FileHash -LiteralPath $index).Hash -ne $manifest.index.sha256) { throw 'Local index differs from this release.' }
$assetPrefix = '/assets/' + $manifest.assetVersion + '/'
if (-not $manifest.assetVersion -or $manifest.assetVersion -notmatch '^[A-Za-z0-9_-]+$' -or -not $manifest.assets.Count) { throw 'Invalid or empty asset manifest.' }
foreach ($asset in $manifest.assets) {
    if (-not $asset.path.StartsWith($assetPrefix) -or $asset.path -match '\.\.|\\|:|\?') { throw 'Invalid asset manifest path.' }
    $localFile = Join-Path $web $asset.path.TrimStart('/')
    if ((Get-FileHash -LiteralPath $localFile).Hash -ne $asset.sha256) { throw "Local asset mismatch: $($asset.path)" }
}
$html = Get-Content -LiteralPath $index -Encoding UTF8 -Raw
$entry = [regex]::Match($html,'<script\b[^>]*src="([^"]+\.js)"')
if (-not $entry.Success -or -not $entry.Groups[1].Value.StartsWith($assetPrefix)) { throw 'Entry does not use this release asset directory.' }
$caddyFile = Join-Path $root 'proxy/Caddyfile'
if (Test-Path -LiteralPath $caddyFile) {
    $caddyExe = Join-Path $root 'proxy/caddy.exe'
    if (-not (Test-Path -LiteralPath $caddyExe)) { throw 'Caddy executable is missing.' }
    $adapted = & $caddyExe adapt --config $caddyFile --adapter caddyfile
    if ($LASTEXITCODE) { throw 'Caddyfile cannot be parsed.' }
    $caddy = ($adapted -join [Environment]::NewLine) | ConvertFrom-Json
    $hosts = @($caddy.apps.http.servers.PSObject.Properties.Value.routes.match.host | ForEach-Object { $_ } | Where-Object { $_ })
    if ($hosts.Count -and $hosts -notcontains $origin.Host) { throw 'Caddy host matcher does not contain the publicUrl hostname.' }
}
Write-Host "PASS: local release files and publicUrl $($config.publicUrl)"
if (-not $CheckHttp) { return }
Add-Type -AssemblyName System.Net.Http
$handler = [Net.Http.HttpClientHandler]::new()
$handler.UseProxy = $false
$handler.AllowAutoRedirect = $false
$client = [Net.Http.HttpClient]::new($handler)
$client.Timeout = [TimeSpan]::FromSeconds(15)
$base = $origin.GetLeftPart([UriPartial]::Authority)
function Check-Response($path, $expectedHash) {
    $response = $client.GetAsync($base + $path).GetAwaiter().GetResult()
    try {
        $bytes = $response.Content.ReadAsByteArrayAsync().GetAwaiter().GetResult()
        if ([int]$response.StatusCode -ne 200 -or $bytes.Length -eq 0) { throw "Empty or failed response: $path ($([int]$response.StatusCode))" }
        $hash = [Security.Cryptography.SHA256]::Create()
        try { $actual = [BitConverter]::ToString($hash.ComputeHash($bytes)).Replace('-','') } finally { $hash.Dispose() }
        if ($actual -ne $expectedHash) { throw "Remote asset differs from release (proxy cache or wrong upstream): $path" }
        $mime = [string]$response.Content.Headers.ContentType
        if (($path.EndsWith('.js') -and $mime -notmatch 'javascript') -or ($path.EndsWith('.css') -and $mime -notmatch 'text/css')) { throw "Wrong content type: $path ($mime)" }
    } finally { $response.Dispose() }
}
try {
    Check-Response '/' $manifest.index.sha256
    foreach ($asset in $manifest.assets) { Check-Response $asset.path $asset.sha256 }
    $session = $client.GetAsync($base+'/api/auth/session').GetAwaiter().GetResult()
    try { if ([int]$session.StatusCode -ne 401) { throw 'Anonymous session must return 401, not an empty 200 or redirect.' } } finally { $session.Dispose() }
    Write-Host "PASS: public HTML, all $($manifest.assets.Count) assets and anonymous session rejection"
} finally { $client.Dispose(); $handler.Dispose() }
