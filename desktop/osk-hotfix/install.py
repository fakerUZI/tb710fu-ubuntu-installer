#!/usr/bin/env python3
"""Install the TB710FU v0.3.0 on-screen keyboard fix."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import stat
import sys
import tempfile

HERE = Path(__file__).resolve().parent
EXTENSIONS = Path('/usr/share/gnome-shell/extensions')


def digest(data):
    return hashlib.sha256(data).hexdigest()


def replace(target, data, info):
    fd, name = tempfile.mkstemp(prefix='.tb-osk-', dir=target.parent)
    try:
        with os.fdopen(fd, 'wb') as f:
            f.write(data)
            os.fchown(f.fileno(), info.st_uid, info.st_gid)
            os.fchmod(f.fileno(), stat.S_IMODE(info.st_mode))
            f.flush()
            os.fsync(f.fileno())
        os.replace(name, target)
    finally:
        Path(name).unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--apply', action='store_true', help='安装补丁，默认只检查')
    args = parser.parse_args()
    model = Path('/sys/firmware/devicetree/base/model')
    if not model.is_file() or b'TB710FU' not in model.read_bytes():
        sys.exit('此补丁适用于 TB710FU。')
    if args.apply and os.geteuid() != 0:
        sys.exit('用 sudo python3 install.py --apply 安装。')
    changes = []
    for row in json.loads((HERE / 'manifest.json').read_text()):
        path = Path(row['path'])
        target = EXTENSIONS / path
        if len(path.parts) != 2 or not target.resolve().is_relative_to(EXTENSIONS):
            sys.exit('发现不安全的扩展路径。')
        info = target.lstat()
        if not stat.S_ISREG(info.st_mode):
            sys.exit(f'扩展文件类型异常：{path}')
        old = target.read_bytes()
        new = (HERE / 'files' / path).read_bytes()
        if digest(new) != row['after']:
            sys.exit(f'补丁校验失败：{path}')
        installed = digest(old)
        if installed == row['after']:
            continue
        if installed not in (row['before'], row.get('previous')):
            sys.exit(f'扩展版本不匹配：{path}。此补丁支持原版 0.3.0 和已发布的屏幕键盘补丁。')
        changes.append((target, new, old, info))
    if not changes:
        print('补丁已安装。重新登录后生效。')
        return
    if not args.apply:
        print(f'检查通过，可更新 {len(changes)} 个扩展文件。')
        return
    backup = Path(tempfile.mkdtemp(prefix='tb710fu-osk-', dir='/var/backups'))
    complete = []
    try:
        for target, new, old, info in changes:
            saved = backup / target.parent.name / target.name
            saved.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(target, saved)
            if digest(saved.read_bytes()) != digest(old):
                raise ValueError(f'文件在备份期间发生变化：{target.name}')
            replace(target, new, info)
            complete.append((target, old, info))
        for target, new, _, _ in changes:
            if digest(target.read_bytes()) != digest(new):
                raise ValueError(f'写入验证失败：{target.name}')
    except BaseException:
        for target, old, info in reversed(complete):
            replace(target, old, info)
        raise
    print(f'补丁已安装并核验。旧文件已备份到 {backup}。请注销并重新登录。')


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError) as error:
        sys.exit(str(error))
