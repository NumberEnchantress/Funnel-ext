<#
.SYNOPSIS
  Removes the One Thing At A Time native file writer. Your log files are not touched.
#>
$ErrorActionPreference = 'Stop'
$Name = 'one_thing_at_a_time'
$Key = "HKCU:\Software\Mozilla\NativeMessagingHosts\$Name"
$Dest = Join-Path $env:LOCALAPPDATA 'OneThingAtATime\native'

if (Test-Path $Key) { Remove-Item -Path $Key -Recurse }
if (Test-Path $Dest) { Remove-Item -Path $Dest -Recurse }
Write-Host 'Removed the native file writer. Your log files were left where they are.' -ForegroundColor Green
