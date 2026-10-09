param([switch]$AtBoot, [switch]$Remove)
$ErrorActionPreference = 'Stop'
$deploymentRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$hash = [Security.Cryptography.SHA256]::Create()
try { $suffix = ([BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes($deploymentRoot)))).Replace('-', '').Substring(0, 8) } finally { $hash.Dispose() }
$taskName = "SuCanvas-Web-$suffix"
if ($Remove) { Unregister-ScheduledTask -TaskName $taskName -Confirm:$false; exit }
$action = New-ScheduledTaskAction -Execute (Join-Path $deploymentRoot 'SuCanvasServer.exe') -Argument ('--config "' + (Join-Path $deploymentRoot 'config.json') + '"') -WorkingDirectory $deploymentRoot
if ($AtBoot) {
    $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
    $trigger = New-ScheduledTaskTrigger -AtStartup
} else {
    $principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $principal.UserId
}
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
Write-Host "Autostart registered: $taskName. This task runs the EXE directly; stop it through Task Scheduler."
