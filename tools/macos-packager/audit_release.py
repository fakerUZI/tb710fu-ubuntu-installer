#!/usr/bin/env python3
"""Review release root; allow the Chrome binary but reject browser user state."""
import argparse
import importlib.util
import re
import sys
from pathlib import Path

spec = importlib.util.spec_from_file_location('base_audit', Path(__file__).with_name('audit-rootfs-base.py'))
base = importlib.util.module_from_spec(spec)
spec.loader.exec_module(base)

CHROME_REJECTION = {
    'excluded application files present: opt/google/chrome',
    'excluded application package installed: google-chrome-stable',
}
PRIVATE_CHROME = (
    'etc/opt/chrome', 'etc/default/google-chrome', 'var/opt/google',
    'etc/skel/.config/google-chrome', 'etc/skel/.cache/google-chrome',
    'var/lib/google-chrome', 'usr/local/share/google-chrome/user-data',
    'opt/google/chrome/User Data', 'opt/google/chrome/user-data',
    'opt/google/chrome/Local State', 'opt/google/chrome/Crash Reports',
    'opt/google/chrome/Crashpad', 'opt/google/chrome/.config',
)

def audit(root, allow_hardware_firmware=False):
    root=Path(root).resolve(strict=True)
    issues=[x for x in base.audit(root,allow_hardware_firmware) if x not in CHROME_REJECTION]
    for name in PRIVATE_CHROME:
        p=root/name
        if p.exists() or p.is_symlink(): issues.append('browser user state or unmanaged policy present: '+name)
    status=(root/'var/lib/dpkg/status').read_text(errors='replace')
    for name in ('google-chrome-stable','tb710fu-repair-assistant'):
        matched=any(re.search(r'^Package: '+re.escape(name)+r'$',p,re.M) and re.search(r'^Status: install ok installed$',p,re.M) for p in status.split('\n\n'))
        if not matched: issues.append('required application package missing: '+name)
    binary=root/'opt/google/chrome/chrome'
    if not binary.is_file() or binary.is_symlink() or not binary.resolve().is_relative_to(root): issues.append('Chrome browser executable missing or unsafe')
    return issues

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('root')
    parser.add_argument('--allow-hardware-firmware',action='store_true')
    args=parser.parse_args()
    try: issues=audit(args.root,args.allow_hardware_firmware)
    except (OSError,ValueError) as exc:
        print('Audit failed:',exc,file=sys.stderr); return 2
    if issues:
        for issue in issues: print('FAIL:',issue)
        return 1
    print('Known checks passed; Chrome and repair assistant present; further privacy, licensing and boot review remain required.')
    return 0

if __name__=='__main__': sys.exit(main())
