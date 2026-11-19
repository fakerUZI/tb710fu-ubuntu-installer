# This entry always sends preserve to the official v0.3 device installer.
$mode = 'preserve'
$archSize = CheckedFastboot -arguments @('-s',$serial,'getvar','partition-size:arch')
if ($archSize -notmatch '(?im)partition-size:arch:\s*0x[0-9a-f]+\b' -or $archSize -match '(?im)partition-size:arch:\s*0x0+\b') { throw 'Existing Ubuntu partition not confirmed.' }
$userdata = Native -exe $fastboot -arguments @('-s',$serial,'getvar','partition-size:userdata')
if ($userdata.Output -match '(?im)partition-size:userdata:\s*0x0*[1-9a-f][0-9a-f]*\b') { throw 'A userdata partition still exists. This migration supports only the single-system layout.' }

$bootBackup = Join-Path $root 'boot-before.img'
if (-not (Test-Path -LiteralPath $bootBackup -PathType Leaf)) { throw 'Run the Ubuntu preflight and place boot-before.img in the migration folder first.' }
if ((Get-Item -LiteralPath $bootBackup).Length -ne 100663296) { throw 'Unexpected boot backup size.' }
$backupHash = (Get-FileHash -LiteralPath $bootBackup -Algorithm SHA256).Hash.ToLowerInvariant()
if ($backupHash -cne '820d71fce5046b594a0c802623e9a658b3b6f6fa0f976f0090c6f76e9b8258c9' -and $backupHash -cne 'b2c5db7b73afebf6b83a0b786000e768186c08e27daa6a8907bf24ff5d61bda2') { throw 'The boot backup is not from an official v0.1 or v0.2 installation.' }

Write-Host 'Upgrade to Ubuntu installer release v0.3.0 and preserve existing accounts and /home.'
Write-Host 'Keep a separate backup of your data. The installer temporarily replaces boot_a.'
if ((Read-Host 'Type KEEP to start migration') -cne 'KEEP') { throw 'Cancelled.' }
