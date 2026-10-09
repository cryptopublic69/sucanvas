$ErrorActionPreference = 'Stop'
$deploymentRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$secret = Read-Host 'New application lock password (4-128 characters)' -AsSecureString
$confirm = Read-Host 'Repeat password' -AsSecureString
$first = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secret)
$second = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($confirm)
try {
    $password = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($first)
    if ($password -cne [Runtime.InteropServices.Marshal]::PtrToStringBSTR($second)) { throw 'Passwords do not match.' }
    $info = New-Object Diagnostics.ProcessStartInfo
    $info.FileName = Join-Path $deploymentRoot 'SuCanvasServer.exe'
    $info.Arguments = '--config "' + (Join-Path $deploymentRoot 'config.json') + '" --set-password'
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardInput = $true
    $process = [Diagnostics.Process]::Start($info)
    $process.StandardInput.WriteLine($password)
    $process.StandardInput.Close()
    $process.WaitForExit()
    if ($process.ExitCode) { throw 'Password initialization failed.' }
} finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($first)
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($second)
    $password = $null
    $secret.Dispose(); $confirm.Dispose()
}
