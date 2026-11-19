#!/usr/bin/env python3
"""Fail-closed checks for known private state in a mounted release rootfs.

This is only one part of a release review; passing cannot establish that all
personal or proprietary material has been removed.
"""
import argparse
import re
from pathlib import Path
import sys


def audit(root, allow_hardware_firmware=False):
    root = Path(root).resolve(strict=True)
    checked = ('etc/os-release', 'var/lib/dpkg/status', 'home', 'root',
               'etc/NetworkManager/system-connections', 'var/lib/bluetooth',
               'var/lib/NetworkManager', 'var/lib/droidloom/users', 'var/crash', 'var/lib/gdm3', 'var/lib/ubuntu-advantage', 'var/lib/snapd', 'etc/machine-id',
               'var/lib/systemd/random-seed', 'etc/ssh', 'opt/QQ',
               'usr/share/applications/qq.desktop', 'etc/shadow', 'etc/passwd',
               'usr/lib/firmware', 'lib/firmware', 'etc/passwd-', 'etc/shadow-',
               'etc/group-', 'etc/gshadow-', 'etc/tb710fu/usb-ncm-host-address',
               'var/backups/tb710fu-snap-support-20261116', 'etc/tb-wifi-credentials.conf',
               'etc/ppp/pap-secrets', 'etc/ppp/chap-secrets', 'etc/apt/auth.conf')
    for rel in checked:
        if not (root / rel).resolve().is_relative_to(root):
            raise ValueError('A checked path escapes the mounted root: ' + rel)
    if not (root / 'etc/os-release').is_file() or not (root / 'var/lib/dpkg/status').is_file():
        raise ValueError('Not a mounted Ubuntu root filesystem')
    issues = []
    def nonempty(rel):
        p = root / rel
        return p.is_file() and p.stat().st_size > 0
    def has_entries(rel):
        p = root / rel
        return p.is_dir() and any(p.iterdir())
    for name in ('home', 'root', 'etc/NetworkManager/system-connections', 'var/lib/bluetooth', 'var/lib/NetworkManager', 'var/lib/droidloom/users', 'var/crash', 'var/lib/gdm3', 'var/lib/ubuntu-advantage', 'var/lib/snapd', 'var/backups/tb710fu-snap-support-20261116'):
        if has_entries(name):
            issues.append(name + ' contains files')
    for name in ('etc/machine-id', 'var/lib/systemd/random-seed', 'etc/tb710fu/usb-ncm-host-address'):
        if nonempty(name):
            issues.append(name + ' is present and nonempty')
    wifi = root / 'etc/tb-wifi-credentials.conf'
    if wifi.is_file() and any(line.strip() and not line.lstrip().startswith('#') for line in wifi.read_text(errors='replace').splitlines()):
        issues.append('legacy Wi-Fi credentials file contains active settings')
    for name in ('etc/ppp/pap-secrets', 'etc/ppp/chap-secrets', 'etc/apt/auth.conf'):
        p = root / name
        if p.is_file() and any(line.strip() and not line.lstrip().startswith('#') for line in p.read_text(errors='replace').splitlines()):
            issues.append(name + ' contains active credentials')
    ssh = root / 'etc/ssh'
    if ssh.is_dir() and any(ssh.glob('ssh_host_*')):
        issues.append('SSH host keys present')
    for name in ('etc/passwd-', 'etc/shadow-', 'etc/group-', 'etc/gshadow-'):
        if (root / name).exists():
            issues.append('account database backup remains: ' + name)
    for name in ('opt/QQ', 'usr/share/applications/qq.desktop', 'opt/WorkBuddy', 'opt/FlClash', 'opt/google/chrome'):
        if (root / name).exists():
            issues.append('excluded application files present: ' + name)
    status = (root / 'var/lib/dpkg/status').read_text(errors='replace')
    for paragraph in status.split('\n\n'):
        app = re.search(r'^Package: (linuxqq|workbuddy|flclash|google-chrome-stable)$', paragraph, re.M)
        if app and re.search(r'^Status: install ok installed$', paragraph, re.M):
            issues.append('excluded application package installed: ' + app.group(1))
    shadow = root / 'etc/shadow'
    passwd = root / 'etc/passwd'
    if not shadow.is_file() or not passwd.is_file():
        issues.append('missing password database')
    else:
        local = {'root'}
        for line in passwd.read_text(errors='replace').splitlines():
            fields = line.split(':')
            if len(fields) >= 7:
                try:
                    if 1000 <= int(fields[2]) < 60000:
                        local.add(fields[0])
                except ValueError:
                    issues.append('invalid passwd entry')
        seen = set()
        for line in shadow.read_text(errors='replace').splitlines():
            fields = line.split(':')
            if len(fields) >= 2 and fields[0] in local:
                seen.add(fields[0])
                if fields[1] and fields[1][0] not in '!*':
                    issues.append('local account has a reusable password hash')
                if not fields[1]:
                    issues.append('local account has an empty password')
        if local - seen:
            issues.append('local account missing shadow entry')
    # Device-specific firmware is private under this project's instructions.
    if not allow_hardware_firmware and (has_entries('usr/lib/firmware') or has_entries('lib/firmware')):
        issues.append('firmware tree present; explicit release authorization and review required')
    return issues


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('root', help='read-only mounted rootfs')
    ap.add_argument('--allow-hardware-firmware', action='store_true', help='acknowledge authorized TB710FU firmware; content still needs review')
    a = ap.parse_args()
    try:
        issues = audit(a.root, allow_hardware_firmware=a.allow_hardware_firmware)
    except (OSError, ValueError) as exc:
        print('Audit failed:', exc, file=sys.stderr)
        return 2
    for issue in issues:
        print('FAIL:', issue)
    if issues:
        return 1
    print('Known checks passed; further privacy, licensing and boot review remain required.')
    return 0

if __name__ == '__main__':
    sys.exit(main())
