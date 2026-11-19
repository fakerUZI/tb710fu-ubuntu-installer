#Requires -Version 5.1
<# Experimental development source. Disabled by default; not a release installer. #>
[CmdletBinding()]
param([switch]$EnableUntested)
$ErrorActionPreference = 'Stop'
if (-not $EnableUntested) { throw 'Development installer is disabled until real hardware validation is complete.' }
$admin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) {
    try {
        $child = Start-Process -FilePath 'powershell.exe' -Verb RunAs -Wait -PassThru `
            -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',('"' + $PSCommandPath + '"'),'-EnableUntested')
        exit $child.ExitCode
    } catch { throw 'Could not obtain administrator access.' }
}
$root = Split-Path -Parent $PSScriptRoot
if ($root.StartsWith('\\')) { throw 'Copy the installer to a local disk before running it.' }
$manifestPath = Join-Path $root 'manifest.json'
if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { throw 'Missing package manifest.' }
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
$required = @('boot/install-single.img','boot/boot-final.img','windows/tools/fastboot.exe','windows/tools/AdbWinApi.dll','windows/tools/AdbWinUsbApi.dll','windows/tools/zstd.exe','windows/tools/nbdserver.exe')
foreach ($rel in $required) {
    $entry = $manifest.files.PSObject.Properties[$rel]
    if (-not $entry -or "$($entry.Value)" -cnotmatch '^[0-9a-f]{64}$') { throw "Missing or invalid manifest entry: $rel" }
    $path = Join-Path $root ($rel -replace '/', '\')
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Missing package file: $rel" }
    if ((Get-FileHash -Algorithm SHA256 -LiteralPath $path).Hash.ToLowerInvariant() -cne $entry.Value) { throw "Checksum mismatch: $rel" }
}
$payloadEntry = $manifest.files.PSObject.Properties['rootfs/ubuntu-nbd.img.zst']
if (-not $payloadEntry -or "$($payloadEntry.Value)" -cnotmatch '^[0-9a-f]{64}$') { throw 'Missing payload checksum.' }
$bundledPayload = Join-Path $root 'rootfs\ubuntu-nbd.img.zst'
if (Test-Path -LiteralPath $bundledPayload -PathType Leaf) {
    if ((Get-FileHash -Algorithm SHA256 -LiteralPath $bundledPayload).Hash.ToLowerInvariant() -cne $payloadEntry.Value) { throw 'Payload checksum mismatch.' }
} elseif (-not $manifest.payload -or @($manifest.payload.parts).Count -eq 0) {
    throw 'Payload is missing and no download sources are specified.'
}
$baseline = (Get-Item -LiteralPath (Join-Path $root 'boot\boot-final.img')).FullName
$baselineHash = 'd83ee187bce60b30c2f28c177b3ab158ea96e5688547e06d3dd4d7a7ed1d6e10'
if ((Get-Item -LiteralPath $baseline).Length -ne 100663296 -or (Get-FileHash -Algorithm SHA256 -LiteralPath $baseline).Hash.ToLowerInvariant() -cne $baselineHash) { throw 'Boot image does not match the verified Ubuntu menu variant.' }
$fastboot = Join-Path $PSScriptRoot 'tools\fastboot.exe'
$zstd = Join-Path $PSScriptRoot 'tools\zstd.exe'
$serverPath = Join-Path $PSScriptRoot 'tools\nbdserver.exe'
function Native([string]$exe, [string[]]$arguments) {
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { $output = & $exe @arguments 2>&1 | Out-String; $code = $LASTEXITCODE }
    finally { $ErrorActionPreference = $previous }
    return [pscustomobject]@{ Output = $output; Code = $code }
}
function CheckedFastboot([string[]]$arguments) {
    $r = Native -exe $fastboot -arguments $arguments
    if ($r.Code -ne 0) { throw 'fastboot command failed.' }
    return $r.Output
}
$devices = @( (CheckedFastboot -arguments @('devices')) -split "`r?`n" | Where-Object { $_ -match '^\s*\S+\s+fastboot\s*$' } )
if ($devices.Count -ne 1) { throw 'Connect exactly one fastboot device.' }
$serial = ($devices[0].Trim() -split '\s+')[0]
$product = CheckedFastboot -arguments @('-s',$serial,'getvar','product')
$unlocked = CheckedFastboot -arguments @('-s',$serial,'getvar','unlocked')
$slot = CheckedFastboot -arguments @('-s',$serial,'getvar','current-slot')
if ($product -notmatch '(?im)^\s*(?:\(bootloader\)\s*)?product:\s*(?:TB710FU|topaz_prc_wifi)\s*$') { throw 'Product is not confirmed as TB710FU; refusing.' }
if ($unlocked -notmatch '(?im)unlocked:\s*yes\b') { throw 'Bootloader is not confirmed unlocked.' }
if ($slot -notmatch '(?im)current-slot:\s*a\b') { throw 'Active slot is not confirmed as a.' }
Write-Host '1: Clean installation from Android or Ubuntu (erases the selected partition).'
Write-Host '2: Reinstall existing Ubuntu, preserving supported user accounts, home files and settings.'
$choice = Read-Host 'Choose 1 or 2'
if ($choice -ceq '1') {
    $mode = 'clean'
    Write-Host 'Clean installation erases all files on the Ubuntu/Android userdata partition.'
    if ((Read-Host 'Type ERASE to continue') -cne 'ERASE') { throw 'Cancelled.' }
} elseif ($choice -ceq '2') {
    $mode = 'preserve'
    # Refuse before flashing the installer if the expected Ubuntu partition is absent.
    $archSize = CheckedFastboot -arguments @('-s',$serial,'getvar','partition-size:arch')
    if ($archSize -notmatch '(?im)partition-size:arch:\s*0x[0-9a-f]+\b' -or $archSize -match '(?im)partition-size:arch:\s*0x0+\b') { throw 'Existing Ubuntu partition not confirmed; preserve mode refused.' }
    Write-Host 'Preserve mode replaces system files and boot but retains supported accounts and /home.'
    Write-Host 'Back up the device first. Other Ubuntu layouts and ID conflicts are refused.'
    Write-Host 'The temporary installer overwrites boot_a before the tablet can verify the Ubuntu filesystem. A failed check can require boot recovery.'
    if ((Read-Host 'Type KEEP to continue') -cne 'KEEP') { throw 'Cancelled.' }
} else { throw 'Invalid installation mode.' }
$working = Join-Path $root ('work\' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $working | Out-Null
$drive = [IO.DriveInfo]::new([IO.Path]::GetPathRoot($working))
if ($drive.AvailableFreeSpace -lt ([int64]40 * 1024 * 1024 * 1024)) { throw 'At least 40 GiB of free space is required on the installer drive.' }
$payload = $bundledPayload
if (-not (Test-Path -LiteralPath $payload -PathType Leaf)) {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $payload = Join-Path $working 'ubuntu-nbd.img.zst'
    $combined = [IO.File]::Open($payload,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
    try {
        $index = 0
        foreach ($part in @($manifest.payload.parts)) {
            $index++
            if ("$($part.sha256)" -cnotmatch '^[0-9a-f]{64}$' -or [int64]$part.size -le 0 -or [int64]$part.size -ge 2147483648) { throw 'Invalid download-part metadata.' }
            $pieceName = 'payload-{0:D3}.part' -f $index
            $piece = Join-Path $root ('rootfs\parts\' + $pieceName)
            $downloaded = $false
            if (-not (Test-Path -LiteralPath $piece -PathType Leaf)) {
                $uri = [Uri]$part.url
                if ($uri.Scheme -cne 'https' -or $uri.Host -cne 'github.com' -or -not $uri.AbsolutePath.StartsWith('/fakerUZI/tb710fu-ubuntu-installer/releases/download/')) { throw 'Untrusted download URL.' }
                $piece = Join-Path $working $pieceName
                Write-Host ('Downloading payload part {0}...' -f $index)
                Invoke-WebRequest -UseBasicParsing -Uri $uri.AbsoluteUri -OutFile $piece
                $downloaded = $true
            }
            if ((Get-Item -LiteralPath $piece).Length -ne [int64]$part.size -or (Get-FileHash -Algorithm SHA256 -LiteralPath $piece).Hash.ToLowerInvariant() -cne $part.sha256) { throw 'Payload part failed verification.' }
            $partStream = [IO.File]::OpenRead($piece)
            try { $partStream.CopyTo($combined) } finally { $partStream.Dispose() }
            if ($downloaded) { Remove-Item -LiteralPath $piece -Force }
        }
        $combined.Flush($true)
    } finally { $combined.Dispose() }
    if ((Get-FileHash -Algorithm SHA256 -LiteralPath $payload).Hash.ToLowerInvariant() -cne $payloadEntry.Value) { throw 'Combined payload checksum mismatch.' }
}
$image = Join-Path $working 'ubuntu-nbd.img'
$z = Native -exe $zstd -arguments @('-d','-q','--no-progress','-o',$image,$payload)
if ($z.Code -ne 0 -or -not (Test-Path -LiteralPath $image -PathType Leaf)) { throw 'Root image decompression failed.' }
# Validate the MBR before writing a private boot image to its reserved control area.
$fs = [IO.File]::Open($image,[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::Read)
try {
    $mbr = New-Object byte[] 512
    if ($fs.Read($mbr,0,512) -ne 512 -or $mbr[510] -ne 0x55 -or $mbr[511] -ne 0xaa) { throw 'Invalid MBR.' }
    $p1start = [BitConverter]::ToUInt32($mbr,454); $p1size = [BitConverter]::ToUInt32($mbr,458)
    $p2start = [BitConverter]::ToUInt32($mbr,470); $p2size = [BitConverter]::ToUInt32($mbr,474)
    if ($p1start -ne 2048 -or $p1size -ne 262144 -or $p2start -ne 264192 -or $p2size -eq 0 -or ([int64]$p2start + $p2size) * 512 -ne $fs.Length) { throw 'Unexpected NBD partition layout.' }
    $bytes = New-Object byte[] 16
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
    $nonce = ([BitConverter]::ToString($bytes)).Replace('-','').ToLowerInvariant()
    $request = [Text.Encoding]::ASCII.GetBytes("TB710FU-REQUEST:${nonce}:${baselineHash}:100663296:${mode}`n")
    $header = New-Object byte[] 4096; [Array]::Copy($request,$header,$request.Length)
    $fs.Position = 1048576; $fs.Write($header,0,$header.Length)
    $bootStream = [IO.File]::OpenRead($baseline)
    try { $bootStream.CopyTo($fs) } finally { $bootStream.Dispose() }
    $fs.Flush($true)
} finally { $fs.Dispose() }
if (Get-NetTCPConnection -LocalPort 10809 -State Listen -ErrorAction SilentlyContinue) { throw 'TCP port 10809 is already in use.' }
$rule = 'TB710FU-Install-' + $nonce
New-NetFirewallRule -Name $rule -DisplayName $rule -Direction Inbound -Action Allow -Protocol TCP -LocalPort 10809 -RemoteAddress 172.16.42.1 -Profile Any | Out-Null
$server = $null; $acknowledged = $false
try {
    $server = Start-Process -FilePath $serverPath -ArgumentList "--image `"$image`" --port 10809" -PassThru -WindowStyle Hidden -RedirectStandardOutput (Join-Path $working 'nbd.log') -RedirectStandardError (Join-Path $working 'nbd.err')
    Start-Sleep -Seconds 2
    if ($server.HasExited) { throw 'NBD server failed to start.' }
    $previousAdapters = @(Get-NetAdapter -ErrorAction SilentlyContinue | Where-Object { $_.Status -eq 'Up' } | ForEach-Object { $_.ifIndex })
    [void](CheckedFastboot -arguments @('-s',$serial,'flash','boot_a',(Join-Path $root 'boot\install-single.img')))
    [void](CheckedFastboot -arguments @('-s',$serial,'reboot'))
    # The tablet appears as a USB network device after reboot. Prefer DHCP;
    # configure only one newly appeared, unambiguous USB adapter as a fallback.
    Write-Host 'Waiting for the tablet USB network adapter...'
    $usbReady = $false
    for ($i = 0; $i -lt 30; $i++) {
        $newUsb = @(Get-NetAdapter -ErrorAction SilentlyContinue | Where-Object {
            $_.Status -eq 'Up' -and $previousAdapters -notcontains $_.ifIndex -and
            $_.InterfaceDescription -match 'RNDIS|NCM|USB Ethernet|Remote NDIS|CDC'
        } | ForEach-Object { $_.ifIndex })
        $usbAddress = @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object {
            $newUsb -contains $_.InterfaceIndex -and $_.IPAddress -match '^172\.16\.42\.(?:[2-9]|10)$'
        })
        if ($usbAddress.Count -gt 0) { $usbReady = $true; break }
        Start-Sleep -Seconds 2
    }
    if (-not $usbReady) {
        $adapters = @(Get-NetAdapter -ErrorAction SilentlyContinue | Where-Object {
            $_.Status -eq 'Up' -and $previousAdapters -notcontains $_.ifIndex -and
            $_.InterfaceDescription -match 'RNDIS|NCM|USB Ethernet|Remote NDIS|CDC'
        })
        if ($adapters.Count -eq 1) {
            try {
                New-NetIPAddress -InterfaceIndex $adapters[0].ifIndex -IPAddress 172.16.42.2 -PrefixLength 24 -ErrorAction Stop | Out-Null
                Write-Host 'Configured the new tablet USB adapter as 172.16.42.2/24.'
            } catch { Write-Warning 'Could not configure the tablet USB adapter automatically.' }
        }
        if ($adapters.Count -ne 1) {
            Write-Warning 'Could not identify one new USB adapter. Set the tablet USB adapter to 172.16.42.2/24 in Network Connections if it does not connect.'
        }
    }
    $deadline = (Get-Date).AddMinutes(45)
    $wanted = New-Object byte[] 512
    $reply = [Text.Encoding]::ASCII.GetBytes("TB710FU-OK:${nonce}`n")
    [Array]::Copy($reply,$wanted,$reply.Length)
    while ((Get-Date) -lt $deadline) {
        if ($server.HasExited) { throw 'NBD server stopped during installation.' }
        $read = [IO.File]::Open($image,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::ReadWrite)
        try { $read.Position = 1048576; $got = New-Object byte[] 512; $count = $read.Read($got,0,512) } finally { $read.Dispose() }
        if ($count -eq 512 -and [Convert]::ToBase64String($got) -ceq [Convert]::ToBase64String($wanted)) { $acknowledged = $true; break }
        Start-Sleep -Seconds 3
    }
    if (-not $acknowledged) { throw 'No verified installation completion signal was received.' }
    Write-Host 'Device reported installation complete and is rebooting. Confirm Ubuntu appears on its screen.'
    Write-Host 'The NBD server remains running until you confirm the tablet has left the installation environment.'
    [void](Read-Host 'Press Enter only after the tablet has rebooted')
} finally {
    if ($acknowledged) {
        if ($server -and -not $server.HasExited) { Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue }
        Remove-NetFirewallRule -Name $rule -ErrorAction SilentlyContinue
    } else {
        Write-Warning 'Installation was not confirmed. NBD server and firewall rule were left running; inspect the tablet before stopping them.'
    }
}
