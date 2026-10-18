$ErrorActionPreference = 'Stop'
# Local recovery for the Web "admin" account: new password, account enabled,
# no forced change. Stop the service first (the server refuses while it runs).
$deploymentRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$secret = Read-Host 'New password for the admin account (4-128 characters)' -AsSecureString
$confirm = Read-Host 'Repeat password' -AsSecureString
$first = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secret)
$second = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($confirm)
try {
    $password = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($first)
    if ($password -cne [Runtime.InteropServices.Marshal]::PtrToStringBSTR($second)) { throw 'Passwords do not match.' }
    $info = New-Object Diagnostics.ProcessStartInfo
    $info.FileName = Join-Path $deploymentRoot 'SuCanvasServer.exe'
    $info.Arguments = '--config "' + (Join-Path $deploymentRoot 'config.json') + '" --reset-admin-password'
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardInput = $true
    $info.RedirectStandardError = $true
    $process = [Diagnostics.Process]::Start($info)
    $process.StandardInput.WriteLine($password)
    $process.StandardInput.Close()
    $errors = $process.StandardError.ReadToEnd()
    $process.WaitForExit()
    if ($process.ExitCode) { throw "Admin password reset failed: $errors" }
    Write-Host 'Admin password reset. Start the service and sign in as admin.'
} finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($first)
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($second)
    $password = $null
    $secret.Dispose(); $confirm.Dispose()
}
