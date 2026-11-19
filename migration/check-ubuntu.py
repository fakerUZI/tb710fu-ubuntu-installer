#!/usr/bin/env python3
"""Check an official v0.1/v0.2 system before running the v0.3 Windows migration."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import sys

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / 'device'))
from merge_accounts import merge, records
from validate_preserve_root import validate

OLD_BOOTS = {
    '820d71fce5046b594a0c802623e9a658b3b6f6fa0f976f0090c6f76e9b8258c9': '0.1.0',
    'b2c5db7b73afebf6b83a0b786000e768186c08e27daa6a8907bf24ff5d61bda2': '0.2.0',
}
BOOT_SIZE = 96 * 1024**2
MIN_FREE = 10 * 1024**3


def check_output(*args):
    return subprocess.check_output(args, text=True).strip()


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def check_accounts(root, ids):
    expected = {
        'passwd': [[name, 'x', uid, gid, '', '', ''] for name, uid, gid in ids['passwd']],
        'group': [[name, 'x', gid, ''] for name, gid in ids['group']],
        'shadow': [[name, '!', '', '', '', '', '', '', ''] for name, _, _ in ids['passwd']],
        'gshadow': [[name, '!', '', ''] for name, _ in ids['group']],
    }
    formats = {'passwd': 7, 'shadow': 9, 'group': 4, 'gshadow': 4}
    existing = {name: records(root / 'etc' / name, fields) for name, fields in formats.items()}
    merge(existing, expected)


def check_disk(profile):
    root_path, root_fs = check_output('findmnt', '-nro', 'SOURCE,FSTYPE', '/').split()
    if root_fs != 'ext4':
        raise ValueError('当前 Ubuntu 根分区不是 ext4。')
    devices = json.loads(check_output('lsblk', '-Jlp', '-o', 'PATH,TYPE,PARTLABEL,PKNAME'))['blockdevices']
    partitions = [entry for entry in devices if entry['type'] == 'part']

    def partition(label):
        matches = [entry for entry in partitions if entry['partlabel'] == label]
        if len(matches) != 1:
            raise ValueError(f'未找到唯一的 {label} 分区。')
        return matches[0]

    root_part = partition('arch')
    if root_part['path'] != root_path or any(p['partlabel'] == 'userdata' for p in partitions):
        raise ValueError('此迁移只支持官方单系统 arch 分区布局。')
    if int(check_output('blockdev', '--getsize64', root_path)) < 32 * 1024**3:
        raise ValueError('Ubuntu 分区小于 32 GiB。')
    boot = partition('boot_a')
    firmware_parts = {label: partition(label) for label in profile['firmware']}
    disks = {entry['pkname'] for entry in (root_part, boot, *firmware_parts.values())}
    for disk in sorted(disks):
        if check_output('lsblk', '-dno', 'PTTYPE', disk) != 'gpt':
            raise ValueError('分区所在磁盘没有可识别的 GPT。')
        result = check_output('sgdisk', '--verify', disk)
        if 'No problems found.' not in result:
            raise ValueError('GPT 检查发现问题。')
    for label, entry in firmware_parts.items():
        if digest(Path(entry['path'])) != profile['firmware'][label]:
            raise ValueError(f'固件分区 {label} 与 0.3 已验证的固件不一致。')
    boot_path = Path(boot['path'])
    if not stat.S_ISBLK(boot_path.stat().st_mode) or int(check_output('blockdev', '--getsize64', str(boot_path))) != BOOT_SIZE:
        raise ValueError('boot_a 大小与官方发布不符。')
    return boot_path


def save_boot(boot_path, boot_hash, directory):
    directory = directory.resolve(strict=True)
    target = directory / 'boot-before.img'
    def private_file(path, flags):
        return os.open(path, flags, 0o600)

    with boot_path.open('rb') as source, open(target, 'xb', opener=private_file) as output:
        try:
            shutil.copyfileobj(source, output)
            output.flush()
            os.fsync(output.fileno())
            if target.stat().st_size != BOOT_SIZE or digest(target) != boot_hash:
                raise ValueError('启动镜像备份校验失败。')
            if 'SUDO_UID' in os.environ:
                os.fchown(output.fileno(), int(os.environ['SUDO_UID']), int(os.environ['SUDO_GID']))
        except BaseException:
            target.unlink(missing_ok=True)
            raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--backup-boot', type=Path, metavar='DIRECTORY')
    args = parser.parse_args()
    if os.geteuid():
        raise ValueError('请用 sudo python3 migration/check-ubuntu.py 运行。')
    model = Path('/sys/firmware/devicetree/base/model').read_bytes()
    if b'TB710FU' not in model or os.uname().machine != 'aarch64':
        raise ValueError('此预检只支持 TB710FU。')
    os.environ['LC_ALL'] = 'C'
    profile = json.loads((HERE / 'v030-system-ids.json').read_text())
    boot = check_disk(profile)
    boot_hash = digest(boot)
    if boot_hash not in OLD_BOOTS:
        raise ValueError('当前启动镜像不匹配官方 0.1 或 0.2。可能是已升级、其他版本或自行修改的系统。')
    count = validate(Path('/'))
    check_accounts(Path('/'), profile)
    if check_output('dpkg', '--audit'):
        raise ValueError('旧系统存在尚未完成的软件包操作。')
    space = os.statvfs('/')
    if space.f_bavail * space.f_frsize < MIN_FREE:
        raise ValueError('Ubuntu 根分区需要至少 10 GiB 空闲。')
    print(f'通过预检：启动镜像匹配 {OLD_BOOTS[boot_hash]}，{count} 个账户的家目录和账户数据库兼容。')
    if args.backup_boot:
        save_boot(boot, boot_hash, args.backup_boot)
        print('已生成并核验 boot-before.img，请复制到 Windows 迁移目录。')


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        sys.exit(f'迁移预检停止：{error}')
