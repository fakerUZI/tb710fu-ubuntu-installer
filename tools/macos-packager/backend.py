#!/usr/bin/env python3
"""TB710FU packaging coordinator. No tablet partitions are written."""
import hashlib, json, os, re, shlex, shutil, subprocess, sys, tempfile, uuid, zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PREP = ROOT / 'ubuntu-tb710fu/release-prep'
SINGLE = PREP/'single-installer'
ART = ROOT/'ubuntu-tb710fu/artifacts'
BOOT = ART/'kernel-20261118-release/ubuntu-kernel-upgrade-20261118/boot.img'
BOOT_HASH = 'd83ee187bce60b30c2f28c177b3ab158ea96e5688547e06d3dd4d7a7ed1d6e10'
OLD_HASH = 'b2c5db7b73afebf6b83a0b786000e768186c08e27daa6a8907bf24ff5d61bda2'
POWER_HASH = 'd2dd8af2204fa89cd15d5cd95c3bfc05944c8c6b4451ab95de500b387e67f3ee'
BACKLIGHT_HASH = '6b13eed0a9f60910e806b923500782534b1b123e42927ee8d79d42c047560f03'
SSH=['/usr/bin/ssh','-o','BatchMode=yes','-o','ConnectTimeout=8','tb710fu-usb']

def digest(path):
    h=hashlib.sha256()
    with path.open('rb') as f:
        for block in iter(lambda:f.read(4*1024*1024),b''): h.update(block)
    return h.hexdigest()
def run(args, *, data=None, capture=True):
    p=subprocess.run(args,input=data,stdout=subprocess.PIPE if capture else None,stderr=subprocess.PIPE if capture else None,check=False)
    if p.returncode:
        message=(p.stderr or b'').decode(errors='replace')[-1000:]
        raise RuntimeError('操作失败：'+message)
    return p.stdout.decode(errors='replace') if capture else ''
def say(s): print(s,flush=True)
def patch_once(s, old, new):
    if s.count(old)!=1: raise RuntimeError('构建脚本版本不匹配，已停止')
    return s.replace(old,new)
def make_scripts(base, inputs, current_user):
    if not re.fullmatch(r'/root/tb710fu-packager/[0-9a-f]{32}',base) or not re.fullmatch(r'/tmp/tb-packager-[0-9a-f]{32}',inputs): raise ValueError('invalid staging path')
    result_dir='/var'+inputs
    snapshot=(PREP/'stage-private-snapshot-20261116.sh').read_text()
    snapshot=patch_once(snapshot,'dir=/root/tb710fu-release-staging',f'dir={base}')
    snapshot=patch_once(snapshot,'--exclude=/tmp --exclude=/mnt --exclude=/media --exclude=/root --exclude=/home', '--exclude=/tmp --exclude=/mnt --exclude=/media --exclude=/root --exclude=/home --exclude=/swapfile')
    chrome_excludes=' --exclude=/etc/opt/chrome --exclude=/etc/default/google-chrome --exclude=/etc/skel/.config/google-chrome --exclude=/etc/skel/.cache/google-chrome --exclude=/var/opt/google --exclude=/var/lib/google-chrome --exclude=/usr/local/share/google-chrome/user-data --exclude="/opt/google/chrome/User Data" --exclude=/opt/google/chrome/user-data --exclude="/opt/google/chrome/Local State" --exclude="/opt/google/chrome/Crash Reports" --exclude=/opt/google/chrome/Crashpad --exclude=/opt/google/chrome/.config'
    snapshot=patch_once(snapshot,'--exclude=/var/lib/droidloom/users',chrome_excludes+' --exclude=/var/lib/droidloom/users')
    sanitize=(PREP/'sanitize-snapshot-20261117-v5.sh').read_text()
    sanitize=patch_once(sanitize,'base=/root/tb710fu-release-staging',f'base={base}')
    sanitize=patch_once(sanitize,'inputs=/tmp/tb-release-inputs-20261116',f'inputs={inputs}')
    sanitize=patch_once(sanitize,'--exclude=/opt/WorkBuddy --exclude=/opt/FlClash --exclude=/opt/google', '--exclude=/opt/WorkBuddy --exclude=/opt/FlClash'+chrome_excludes)
    sanitize=patch_once(sanitize,'for package in workbuddy google-chrome-stable flclash;', 'for package in workbuddy flclash;')
    # The retired front-camera evidence is excluded by its private backup path;
    # do not drop all current camera drivers merely because of their name.
    sanitize=patch_once(sanitize,"--exclude='*gc13a2*' --exclude='*GC13A2*' --exclude='*boot-front-power-test*'", "--exclude='*boot-front-power-test*' --exclude='*/retired-front-camera-20261113/***'")
    # Never downgrade the running repair assistant to an older baked-in .deb.
    sanitize=patch_once(sanitize,'install -m 644 "$inputs/tb710fu-repair-assistant_0.10.7_all.deb" "$d/tmp/tb-repair.deb"\n','')
    sanitize=patch_once(sanitize,'chroot "$d" dpkg -i /tmp/tb-repair.deb\n','')
    sanitize=patch_once(sanitize,'unlink "$d/tmp/tb-repair.deb"\n','')
    # Chrome is already present in the clean snapshot. Do not download or
    # install a different browser or copy the host's resolver configuration.
    apt_block='''# Bind the live resolver without copying local network addresses into the image.
resolver_link=$(readlink "$d/etc/resolv.conf" || true)
rm -f "$d/etc/resolv.conf"
touch "$d/etc/resolv.conf"
mount --bind /etc/resolv.conf "$d/etc/resolv.conf"
chroot "$d" apt-get update -qq
DEBIAN_FRONTEND=noninteractive chroot "$d" apt-get install -y --no-install-recommends epiphany-browser
umount "$d/etc/resolv.conf"
rm -f "$d/etc/resolv.conf"
if [ -n "$resolver_link" ]; then ln -s "$resolver_link" "$d/etc/resolv.conf"; fi
chroot "$d" apt-get clean
'''
    sanitize=patch_once(sanitize,apt_block,'')
    # Install verified shared extension rather than copying the user's home.
    marker='install -m 755 "$inputs/tb-install-single.sh" "$d/usr/local/sbin/tb-install-single"'
    additions='''install -d -m 755 "$d/usr/share/gnome-shell/extensions/tb-android-window-defaults@tb710fu"
for name in extension.js navigation.js metadata.json stylesheet.css; do install -m 644 "$inputs/window-$name" "$d/usr/share/gnome-shell/extensions/tb-android-window-defaults@tb710fu/$name"; done
python3 - "$d/etc/dconf/db/local.d/00-tb710fu" <<'PYEXT'
import ast,sys
from pathlib import Path
p=Path(sys.argv[1]); lines=p.read_text().splitlines(); indexes=[i for i,v in enumerate(lines) if v.startswith('enabled-extensions=')]; assert len(indexes)==1
i=indexes[0]; items=ast.literal_eval(lines[i].split('=',1)[1]); assert isinstance(items,list)
if 'tb-android-window-defaults@tb710fu' not in items: items.append('tb-android-window-defaults@tb710fu')
lines[i]='enabled-extensions='+repr(items); p.write_text('\\n'.join(lines)+'\\n')
PYEXT
'''
    sanitize=patch_once(sanitize,marker,additions+marker)
    finalize=(PREP/'finalize-clean-root-20261117-v5.sh').read_text().replace('base=/root/tb710fu-release-staging',f'base={base}').replace('inputs=/tmp/tb-release-inputs-20261116',f'inputs={inputs}')
    finalize=patch_once(finalize,'[ "$(chroot "$m" dpkg-query -W -f=\'${Status}\' epiphany-browser)" = \'install ok installed\' ] || { echo \'Browser package missing\' >&2; exit 1; }\n','')
    finalize=patch_once(finalize,'install -D -m 644 "$inputs/catalog-seed.json" "$m/etc/skel/.local/share/tb710fu-repair-assistant/catalog.json"', 'install -D -m 644 "$m/usr/share/tb710fu-repair-assistant/catalog-seed.json" "$m/etc/skel/.local/share/tb710fu-repair-assistant/catalog.json"')
    nbd=(PREP/'build-release-nbd-20261117-v5.sh').read_text().replace('base=/root/tb710fu-release-staging',f'base={base}').replace('/tmp/tb-release-inputs-20261116',inputs)
    old_pattern=r'install -d -m 700 -o [^\n]+\ncp "\$out\.zst" "\$out\.zst\.sha256" [^\n]+\nchown [^\n]+'
    new='''owner=$(stat -c %u "$inputs")
group=$(stat -c %g "$inputs")
[ -d "$result_dir" ] && [ ! -L "$result_dir" ] && [ "$(stat -c %u "$result_dir")" = "$owner" ] || exit 1
install -m 600 -o "$owner" -g "$group" "$out.zst" "$result_dir/payload.img.zst"
install -m 600 -o "$owner" -g "$group" "$out.zst.sha256" "$result_dir/payload.sha256"'''
    nbd,count=re.subn(old_pattern,lambda _:new,nbd)
    if count!=1: raise RuntimeError('构建脚本版本不匹配，已停止')
    nbd=patch_once(nbd,f'base={base}\n',f'base={base}\ninputs={inputs}\nresult_dir={result_dir}\n')
    return snapshot,sanitize,finalize,nbd

def prepare_inputs(folder, base, remote):
    os.chmod(folder,0o700)
    scripts=make_scripts(base,remote,'')
    for name,content in zip(('1-snapshot.sh','2-sanitize.sh','3-finalize.sh','4-nbd.sh'),scripts): (folder/name).write_text(content)
    mapping={
      'sanitize_accounts.py':PREP/'sanitize_accounts.py','audit-rootfs.py':Path(__file__).with_name('audit_release.py'),'audit-rootfs-base.py':PREP/'audit-rootfs.py','scan_private_markers.py':PREP/'scan_private_markers.py',
      'first_user_provision.py':PREP/'first_user_provision.py','first-user-provision.service':PREP/'first-user-provision.service',
      'tb-power-key.py':Path(__file__).with_name('tb-power-key-reviewed.py'),
      'tb-backlight-power-user.py':ROOT/'ubuntu-tb710fu/offline-prep/power-session/tb-backlight-power-user.py',
      'fcitx-session-start.py':ROOT/'ubuntu-tb710fu/offline-prep/wowtype-osk/fcitx-session-start.py',
      'backspace-extension.js':ROOT/'ubuntu-tb710fu/offline-prep/osk-backspace-fallback/extension.js',
      'backspace-metadata.json':ROOT/'ubuntu-tb710fu/offline-prep/osk-backspace-fallback/metadata.json',
      '95-tb710fu-playback-clock.conf':PREP/'generic-user/95-tb710fu-playback-clock.conf',
      'droidloom-launch':PREP/'generic-user/droidloom-launch','droidloom-fix-launchers':PREP/'generic-user/droidloom-fix-launchers',
      'droidloom-watch-launchers':PREP/'generic-user/droidloom-watch-launchers','droidloom-watch-launchers.service':PREP/'generic-user/droidloom-watch-launchers.service',
      'merge_accounts.py':SINGLE/'merge_accounts.py','validate_preserve_root.py':SINGLE/'validate_preserve_root.py',
      'tb-installer.service':SINGLE/'tb-installer.service','catalog-seed.json':PREP/'generic-user/catalog-seed.json',
    }
    for name,p in mapping.items():
        if not p.is_file() or p.is_symlink(): raise RuntimeError('缺少构建输入：'+name)
        shutil.copyfile(p,folder/name)
    for name in ('extension.js','navigation.js','metadata.json','stylesheet.css'):
        shutil.copyfile(ROOT/'ubuntu-tb710fu/offline-prep/android-window-controls'/name,folder/('window-'+name))
    install=(SINGLE/'tb-install-single.sh').read_text()
    (folder/'tb-install-single.sh').write_text(patch_once(install,OLD_HASH,BOOT_HASH))
    (folder/'run.sh').write_text('''#!/bin/bash
set -euo pipefail
umask 077
mkdir -p -m 700 "$1"
[ "$(sha256sum /dev/disk/by-partlabel/boot_a | awk '{print $1}')" = d83ee187bce60b30c2f28c177b3ab158ea96e5688547e06d3dd4d7a7ed1d6e10 ] || exit 1
python3 "$2/scan_private_markers.py" /dev/disk/by-partlabel/boot_a
for s in 1-snapshot.sh 2-sanitize.sh 3-finalize.sh 4-nbd.sh; do printf '阶段：%s\\n' "$s"; /bin/bash "$2/$s"; done
[ "$(sha256sum /dev/disk/by-partlabel/boot_a | awk '{print $1}')" = d83ee187bce60b30c2f28c177b3ab158ea96e5688547e06d3dd4d7a7ed1d6e10 ] || exit 1
python3 - "$1" <<'PYCLEAN'
import re,shutil,sys
from pathlib import Path
p=Path(sys.argv[1]); assert re.fullmatch(r'/root/tb710fu-packager/[0-9a-f]{32}',str(p)) and not p.is_symlink()
shutil.rmtree(p)
PYCLEAN
''')

def check_live(password):
    if not BOOT.is_file() or digest(BOOT)!=BOOT_HASH: raise RuntimeError('已审核的 20261118 启动镜像缺失或哈希不符')
    for name,path,want in [
      ('安装引导',ART/'ubuntu-release-20261116/prior-install-single.img','00b173cc27b5fb359fc8d3defeae442c7762ba1db243f054af91600abff21bf7'),
      ('NBD 服务',ART/'ubuntu-release-20261116/prior-nbdserver.exe','0cf970f861f7daf60e5158bf0796ec50f3891ed7c725f76040e1e1b8f92ae2ed'),
      ('电源键脚本',Path(__file__).with_name('tb-power-key-reviewed.py'),POWER_HASH),
      ('背光脚本',ROOT/'ubuntu-tb710fu/offline-prep/power-session/tb-backlight-power-user.py',BACKLIGHT_HASH)]:
        if not path.is_file() or digest(path)!=want: raise RuntimeError(name+'资源已变化或缺失，已停止')
    out=run(SSH+['uname -r; tr "\\0" " " </sys/firmware/devicetree/base/model'])
    if not out.startswith('7.2.6-tb710fu-20261118\n') or 'TB710FU' not in out: raise RuntimeError('平板型号或内核不在当前已审核范围，已停止')
    run(SSH+['test -d /lib/modules/7.2.6-tb710fu && test -d /lib/modules/7.2.6-tb710fu-20261118 && command -v rsync >/dev/null && command -v zstd >/dev/null && command -v sgdisk >/dev/null'])
    apps=run(SSH+["dpkg-query -W -f='${Status}\\n' google-chrome-stable tb710fu-repair-assistant"])
    if apps.splitlines()!=['install ok installed','install ok installed']: raise RuntimeError('平板必须已安装 Chrome 和修复助手')
    inspection='''set -eu
root=$(findmnt -n -o SOURCE /)
parent=$(lsblk -ndo PKNAME "$root")
case "$parent" in sd[a-z]*) ;; *) exit 1;; esac
[ "$(lsblk -ndo PTTYPE "/dev/$parent")" = gpt ]
sgdisk --verify "/dev/$parent" >/dev/null
[ "$(df -Pk /root | awk 'NR==2 {print $4}')" -gt 73400320 ]
[ "$(stat -f -c %T /var/tmp)" != tmpfs ]
[ "$(df -Pk /var/tmp | awk 'NR==2 {print $4}')" -gt 10485760 ]
printf 'GPT_AND_SPACE_OK\\n'
'''
    cmd='sudo -S -p "" /bin/sh -c '+shlex.quote(inspection)
    if 'GPT_AND_SPACE_OK' not in run(SSH+[cmd],data=(password+'\n').encode()): raise RuntimeError('当前 GPT 检查失败或设备剩余空间不足 70 GiB')
    output=run(SSH+['sudo -S -p "" sha256sum /dev/disk/by-partlabel/boot_a'],data=(password+'\n').encode())
    if output.split()[0]!=BOOT_HASH: raise RuntimeError('当前启动镜像与审核版本不一致，已停止')
    out=run(SSH+['sha256sum "$HOME/.local/bin/tb-power-key.py"'])
    if out.split()[0]!=POWER_HASH: raise RuntimeError('当前电源键修复已变化，需要审核后才能打包')
    out=run(SSH+['sha256sum "$HOME/.local/bin/tb-backlight-power-user.py"'])
    if out.split()[0]!=BACKLIGHT_HASH: raise RuntimeError('当前背光修复已变化，需要审核后才能打包')
    for n in ('extension.js','navigation.js','metadata.json','stylesheet.css'):
        out=run(SSH+[f'sha256sum "$HOME/.local/share/gnome-shell/extensions/tb-android-window-defaults@tb710fu/{n}"'])
        if out.split()[0]!=digest(ROOT/'ubuntu-tb710fu/offline-prep/android-window-controls'/n): raise RuntimeError('安卓窗口扩展已变化，需要审核后才能打包')
    for n in ('extension.js','metadata.json'):
        out=run(SSH+[f'sha256sum "$HOME/.local/share/gnome-shell/extensions/tb-backspace-fallback@tb710fu/{n}"'])
        if out.split()[0]!=digest(ROOT/'ubuntu-tb710fu/offline-prep/osk-backspace-fallback'/n): raise RuntimeError('屏幕键盘修复已变化，需要审核后才能打包')
    out=run(SSH+['sha256sum "$HOME/.local/libexec/tb-fcitx5-session.py"'])
    if out.split()[0]!=digest(ROOT/'ubuntu-tb710fu/offline-prep/wowtype-osk/fcitx-session-start.py'): raise RuntimeError('输入法启动修复已变化，需要审核后才能打包')

def assemble(payload, target):
    sys.path.insert(0,str(SINGLE)); from payload_parts import split_payload
    tools=ROOT/'ubuntu-tb710fu/sources/TB710FU-Archlinux/build/rom/windows/tools'
    final=target/f'TB710FU-Ubuntu-{__import__("datetime").datetime.now():%Y%m%d-%H%M%S}-preview.zip'
    if final.exists(): raise RuntimeError('目标文件已存在')
    files={'boot/install-single.img':ART/'ubuntu-release-20261116/prior-install-single.img','boot/boot-final.img':BOOT,'windows/install.cmd':SINGLE/'windows/install.cmd','windows/tools/nbdserver.exe':ART/'ubuntu-release-20261116/prior-nbdserver.exe','windows/tools/LICENSE-nbdserver.txt':SINGLE/'nbdserver/LICENSE'}
    for name in ('fastboot.exe','AdbWinApi.dll','AdbWinUsbApi.dll','zstd.exe','NOTICE-platform-tools.txt','LICENSE-zstd.txt'): files['windows/tools/'+name]=tools/name
    with tempfile.TemporaryDirectory(prefix='tb-kit-',dir=str(target)) as td:
        kit=Path(td)/'TB710FU-Ubuntu-Windows'; kit.mkdir()
        hashes={}
        for rel,src in files.items():
            if not src.is_file() or src.is_symlink(): raise RuntimeError('缺少安装器文件：'+rel)
            dst=kit/rel; dst.parent.mkdir(parents=True,exist_ok=True); shutil.copyfile(src,dst); hashes[rel]=digest(dst)
        readme=(SINGLE/'README-DEV.zh-CN.txt').read_text()
        readme=patch_once(readme,'公开镜像不包含 QQ、WorkBuddy、FlClash 或 Google Chrome；提供 GNOME Web 浏览器，其他应用由使用者自行获取。','镜像保留修复助手和 Google Chrome；Chrome 用户资料、账户、浏览记录及缓存不会随包复制。QQ、WorkBuddy 和 FlClash 不包含在镜像中。')
        (kit/'README.zh-CN.txt').write_text(readme); hashes['README.zh-CN.txt']=digest(kit/'README.zh-CN.txt')
        ps=patch_once((SINGLE/'windows/install.ps1').read_text(),OLD_HASH,BOOT_HASH)
        (kit/'windows/install.ps1').write_text(ps); hashes['windows/install.ps1']=digest(kit/'windows/install.ps1')
        folder=kit/'rootfs/parts'; folder.mkdir(parents=True)
        whole,parts=split_payload(payload,folder)
        hashes['rootfs/ubuntu-nbd.img.zst']=whole
        (kit/'manifest.json').write_text(json.dumps({'status':'EXPERIMENTAL - WINDOWS END-TO-END UNTESTED','files':hashes,'payload':{'parts':parts}},indent=2,ensure_ascii=False)+'\n')
        tmp=final.with_suffix('.zip.partial')
        try:
            with zipfile.ZipFile(tmp,'x',allowZip64=True,compression=zipfile.ZIP_DEFLATED,compresslevel=1) as z:
                for p in sorted(kit.rglob('*')):
                    if p.is_symlink(): raise RuntimeError('发现不安全链接')
                    if p.is_file(): z.write(p,Path(kit.name)/p.relative_to(kit),compress_type=zipfile.ZIP_STORED if p.suffix=='.part' else zipfile.ZIP_DEFLATED)
            with zipfile.ZipFile(tmp) as z:
                if z.testzip() is not None: raise RuntimeError('ZIP 完整性检查失败')
            sha=digest(tmp); os.replace(tmp,final)
            final.with_suffix(final.suffix+'.sha256').write_text(sha+'  '+final.name+'\n')
        finally:
            if tmp.exists(): tmp.unlink()
    return final

def main():
    config=json.loads(sys.stdin.readline()); password=config.pop('password','')
    if not isinstance(password,str) or '\n' in password or '\r' in password: raise ValueError('密码格式无效')
    target=Path(config['output']).expanduser().resolve(strict=True)
    if not target.is_dir(): raise ValueError('输出位置不是文件夹')
    if shutil.disk_usage(target).free < 50*1024**3: raise RuntimeError('Mac 输出磁盘至少需要 50 GiB 可用空间')
    say('正在核对设备和已审核的启动镜像…'); check_live(password)
    say('设备核对通过。开始创建私密工作区并构建脱敏候选。')
    job=uuid.uuid4().hex; remote='/tmp/tb-packager-'+job; result_dir='/var'+remote; base='/root/tb710fu-packager/'+job
    with tempfile.TemporaryDirectory(prefix='tb-packager-input-') as td:
        folder=Path(td); prepare_inputs(folder,base,remote)
        run(SSH+['mkdir -m 700 '+shlex.quote(remote)+' '+shlex.quote(result_dir)])
        run(['/usr/bin/scp','-q',*[str(p) for p in folder.iterdir()],'tb710fu-usb:'+remote+'/'])
        command='sudo -S -p "" /bin/bash '+shlex.quote(remote+'/run.sh')+' '+shlex.quote(base)+' '+shlex.quote(remote)
        p=subprocess.Popen(SSH+[command],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True,bufsize=1)
        p.stdin.write(password+'\n'); p.stdin.close(); password=''
        for line in p.stdout:
            if any(x in line for x in ('阶段：','DONE','PASSED','READY','Known checks','Error','error','FAIL','失败')): say(line.rstrip())
        if p.wait(): raise RuntimeError('设备端构建失败，未生成可分享的安装包；私密工作区已保留供排查')
        say('正在传回并校验镜像…')
        payload=Path(td)/'payload.img.zst'; sums=Path(td)/'payload.sha256'
        run(['/usr/bin/scp','-q','tb710fu-usb:'+result_dir+'/payload.img.zst',str(payload)])
        run(['/usr/bin/scp','-q','tb710fu-usb:'+result_dir+'/payload.sha256',str(sums)])
        if digest(payload)!=sums.read_text().split()[0]: raise RuntimeError('镜像传输校验失败')
        say('正在生成并检查 Windows ZIP…'); result=assemble(payload,target)
        cleanup='import re,shutil,sys; paths=sys.argv[1:]; assert len(paths)==2 and all(re.fullmatch(r"/(?:var/)?tmp/tb-packager-[0-9a-f]{32}",p) for p in paths); [shutil.rmtree(p) for p in paths]'
        try: run(SSH+['python3 -c '+shlex.quote(cleanup)+' '+shlex.quote(remote)+' '+shlex.quote(result_dir)])
        except RuntimeError: say('提示：设备临时目录未自动清理：'+remote+'、'+result_dir)
        say('完成：'+str(result)); say('注意：这是预览版，Windows 实机和保留数据安装仍需验证；已知隐私扫描无法保证覆盖所有个人数据。')

if __name__=='__main__':
    try: main()
    except Exception as exc:
        print('错误：'+str(exc),flush=True); sys.exit(1)
