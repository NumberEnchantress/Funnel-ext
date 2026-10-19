<#
.SYNOPSIS
  Installs the One Thing At A Time native file writer for Firefox (current user only, no admin rights needed).

.DESCRIPTION
  - Copies otaat_host.py to %LOCALAPPDATA%\OneThingAtATime\native
  - Creates a small launcher (otaat_host.bat) that runs it with your Python 3
  - Registers it with Firefox under HKCU\Software\Mozilla\NativeMessagingHosts\one_thing_at_a_time
  - Sends it a test message

  Run again any time to repair. Remove with uninstall-windows.ps1.

.PARAMETER Python
  Full path to python.exe, if it can't be found automatically.

.PARAMETER LogFolder
  Where the log files go when the extension's "Native writer folder" setting is empty
  (e.g. -LogFolder "$HOME\Documents\OTAAT"). Created if missing. Without it, an earlier choice is
  kept, otherwise Documents\OneThingAtATime is used.
#>
param([string]$Python = '', [string]$LogFolder = '')

$ErrorActionPreference = 'Stop'
$Name = 'one_thing_at_a_time'
$ExtensionId = 'one-thing-at-a-time@otaat'
$Source = Split-Path -Parent $MyInvocation.MyCommand.Path
$Dest = Join-Path $env:LOCALAPPDATA 'OneThingAtATime\native'

function Find-Python {
    $candidates = @()
    $launcher = Get-Command py.exe -ErrorAction SilentlyContinue
    if ($launcher) {
        try {
            $exe = & $launcher.Source -3 -c "import sys; print(sys.executable)" 2>$null
            if ($LASTEXITCODE -eq 0 -and $exe) { $candidates += $exe.Trim() }
        } catch { }
    }
    foreach ($n in 'python.exe', 'python3.exe') {
        $c = Get-Command $n -ErrorAction SilentlyContinue
        # Skip the Microsoft Store stub, which opens the Store instead of running Python.
        if ($c -and $c.Source -notlike '*\WindowsApps\*') { $candidates += $c.Source }
    }
    foreach ($c in $candidates) {
        if (-not (Test-Path $c)) { continue }
        $v = & $c -c "import sys; print(sys.version_info[0])" 2>$null
        if ($LASTEXITCODE -eq 0 -and "$v".Trim() -eq '3') { return $c }
    }
    return $null
}

if (-not $Python) { $Python = Find-Python }
if (-not $Python -or -not (Test-Path $Python)) {
    throw 'Python 3 was not found. Install it from https://www.python.org/downloads/ (tick "Add to PATH"), then run this again, or pass -Python C:\path\to\python.exe'
}
# Batch files are read in the console code page; use the 8.3 short path if the real one has non-ASCII characters.
if ($Python -match '[^\x20-\x7E]') {
    try { $Python = (New-Object -ComObject Scripting.FileSystemObject).GetFile($Python).ShortPath } catch { }
}

New-Item -ItemType Directory -Force -Path $Dest | Out-Null
Copy-Item -Force (Join-Path $Source 'otaat_host.py') $Dest

if ($LogFolder) {
    $LogFolder = [System.IO.Path]::GetFullPath([Environment]::ExpandEnvironmentVariables($LogFolder))
    New-Item -ItemType Directory -Force -Path $LogFolder | Out-Null
    $config = [ordered]@{ folder = $LogFolder }
    [System.IO.File]::WriteAllText((Join-Path $Dest 'otaat_host_config.json'), ($config | ConvertTo-Json), (New-Object System.Text.UTF8Encoding($false)))
}

$Bat = Join-Path $Dest 'otaat_host.bat'
$batText = "@echo off`r`n`"$Python`" -I -u `"%~dp0otaat_host.py`" %*`r`n"
[System.IO.File]::WriteAllText($Bat, $batText, [System.Text.Encoding]::ASCII)

$ManifestPath = Join-Path $Dest "$Name.json"
$manifest = [ordered]@{
    name               = $Name
    description        = 'One Thing At A Time - writes your feed logs to plain files'
    path               = $Bat
    type               = 'stdio'
    allowed_extensions = @($ExtensionId)
}
[System.IO.File]::WriteAllText($ManifestPath, ($manifest | ConvertTo-Json), (New-Object System.Text.UTF8Encoding($false)))

$Key = "HKCU:\Software\Mozilla\NativeMessagingHosts\$Name"
New-Item -Path $Key -Force | Out-Null
Set-ItemProperty -Path $Key -Name '(default)' -Value $ManifestPath

# Self-test: send {"type":"hello"} exactly the way Firefox does.
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = $env:ComSpec
$psi.Arguments = "/d /c `"`"$Bat`"`""
$psi.UseShellExecute = $false
$psi.RedirectStandardInput = $true
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError = $true
$psi.CreateNoWindow = $true
$proc = [System.Diagnostics.Process]::Start($psi)
$payload = [System.Text.Encoding]::UTF8.GetBytes('{"type":"hello","folder":""}')
$stdin = $proc.StandardInput.BaseStream
$stdin.Write([BitConverter]::GetBytes([UInt32]$payload.Length), 0, 4)
$stdin.Write($payload, 0, $payload.Length)
$stdin.Flush()
$stdin.Close()
$out = $proc.StandardOutput.BaseStream
$lenBytes = New-Object byte[] 4
$read = $out.Read($lenBytes, 0, 4)
$reply = $null
if ($read -eq 4) {
    $len = [BitConverter]::ToUInt32($lenBytes, 0)
    $buf = New-Object byte[] $len
    $got = 0
    while ($got -lt $len) {
        $n = $out.Read($buf, $got, $len - $got)
        if ($n -le 0) { break }
        $got += $n
    }
    $reply = [System.Text.Encoding]::UTF8.GetString($buf, 0, $got) | ConvertFrom-Json
}
$proc.WaitForExit(5000) | Out-Null
$err = $proc.StandardError.ReadToEnd()

if ($reply -and $reply.ok) {
    Write-Host ''
    Write-Host 'Installed the One Thing At A Time file writer.' -ForegroundColor Green
    Write-Host "  Python:       $Python"
    Write-Host "  Host:         $Bat"
    Write-Host "  Log folder:   $($reply.folder)  (change it in the extension's Settings)"
    Write-Host ''
    Write-Host "In Firefox, open the extension's Settings and press 'Check native writer'."
} else {
    Write-Warning "Registered, but the self-test did not get a reply. $err"
    exit 1
}
