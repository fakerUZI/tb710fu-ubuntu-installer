#!/usr/bin/env python3
"""Create the preserve-only migration launcher from the public v0.3 bootstrap."""
import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import zipfile

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
PREFIX = 'TB710FU-Ubuntu-v0.3.0-Migration'
BOOTSTRAP_SHA256 = 'a946bf11568a74ace1027740efd5acdd08d9da12fd30640e7e0c0f4e7b288373'
BOOT = 'd83ee187bce60b30c2f28c177b3ab158ea96e5688547e06d3dd4d7a7ed1d6e10'
INSTALLER = '00b173cc27b5fb359fc8d3defeae442c7762ba1db243f054af91600abff21bf7'
PAYLOAD = '5952dd195ecf02e7d6cf1e3fc1718bc44e7b8adede5f8ac2ddd7e3bc1790f1f1'


def hash_bytes(data):
    return hashlib.sha256(data).hexdigest()


def migration_mode(script):
    start = script.index("Write-Host '1: Clean installation")
    stop = script.index('$working = Join-Path', start)
    return script[:start] + (HERE / 'preserve-mode.ps1').read_text() + '\n' + script[stop:]


def build(source, output):
    with source.open('rb') as stream:
        if hashlib.file_digest(stream, 'sha256').hexdigest() != BOOTSTRAP_SHA256:
            raise ValueError('Expected the byte-identical official v0.3 bootstrap ZIP')
    with zipfile.ZipFile(source) as archive:
        manifests = [name for name in archive.namelist() if name.endswith('/manifest.json')]
        if len(manifests) != 1:
            raise ValueError('Expected the official v0.3 bootstrap ZIP')
        prefix = manifests[0].removesuffix('manifest.json')
        manifest = json.loads(archive.read(manifests[0]))
        if (manifest['files']['boot/boot-final.img'], manifest['files']['boot/install-single.img'],
            manifest['files']['rootfs/ubuntu-nbd.img.zst']) != (BOOT, INSTALLER, PAYLOAD):
            raise ValueError('Bootstrap does not match the v0.3 release')
        parts = manifest['payload']['parts']
        if not parts or any(part['url'] !=
                            f'https://github.com/fakerUZI/tb710fu-ubuntu-installer/releases/download/v0.3.0/payload-{index:03}.part'
                            for index, part in enumerate(parts, 1)):
            raise ValueError('Unexpected v0.3 payload URLs')
        files = {}
        skip = {'rootfs/ubuntu-nbd.img.zst', 'windows/install.cmd', 'README.zh-CN.txt'}
        for name, expected in manifest['files'].items():
            path = PurePosixPath(name)
            if path.is_absolute() or '..' in path.parts or '\\' in name:
                raise ValueError('Unsafe bootstrap path')
            if name in skip:
                continue
            data = archive.read(prefix + name)
            if hash_bytes(data) != expected:
                raise ValueError(f'SHA-256 mismatch: {name}')
            files[name] = data
    files['windows/install.ps1'] = migration_mode(files['windows/install.ps1'].decode('utf-8-sig')).encode('utf-8')
    files['windows/migrate-to-030.cmd'] = (HERE / 'migrate-to-030.cmd').read_text().replace('\n', '\r\n').encode('ascii')
    files['README.zh-CN.txt'] = (HERE / 'README.md').read_bytes()
    for path in ('migration/check-ubuntu.py', 'migration/v030-system-ids.json',
                 'device/validate_preserve_root.py', 'device/merge_accounts.py'):
        files[path] = (ROOT / path).read_bytes()
    manifest['files'] = {name: hash_bytes(data) for name, data in files.items()}
    manifest['files']['rootfs/ubuntu-nbd.img.zst'] = PAYLOAD
    with zipfile.ZipFile(output, 'x', compression=zipfile.ZIP_DEFLATED, compresslevel=1) as archive:
        for name, data in files.items():
            archive.writestr(f'{PREFIX}/{name}', data)
        archive.writestr(f'{PREFIX}/manifest.json', json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')
    with zipfile.ZipFile(output) as archive:
        if archive.testzip() is not None:
            raise ValueError('CRC verification failed')


if __name__ == '__main__':
    cli = argparse.ArgumentParser(description=__doc__)
    cli.add_argument('source', type=Path)
    cli.add_argument('output', type=Path)
    args = cli.parse_args()
    build(args.source, args.output)
