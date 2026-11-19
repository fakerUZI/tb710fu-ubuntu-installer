#!/usr/bin/env python3
"""Build a locally usable, self-contained macOS application bundle."""
from pathlib import Path
import os, shutil, subprocess, tempfile
ROOT=Path(__file__).resolve().parents[2]
BASE=ROOT/'ubuntu-tb710fu/macos-packager'
destination=BASE/'TB710FU Ubuntu 打包工具.app'
if destination.exists(): raise SystemExit('应用已存在，拒绝覆盖：'+str(destination))
stage=Path(tempfile.mkdtemp(prefix='tb-macos-app-build-'))
app=stage/destination.name
contents=app/'Contents'; res=contents/'Resources'; workspace=res/'workspace'
inputs=[
 'ubuntu-tb710fu/macos-packager/backend.py','ubuntu-tb710fu/macos-packager/audit_release.py','ubuntu-tb710fu/macos-packager/tb-power-key-reviewed.py',
 'ubuntu-tb710fu/release-prep/stage-private-snapshot-20261116.sh','ubuntu-tb710fu/release-prep/sanitize-snapshot-20261117-v5.sh',
 'ubuntu-tb710fu/release-prep/finalize-clean-root-20261117-v5.sh','ubuntu-tb710fu/release-prep/build-release-nbd-20261117-v5.sh',
 'ubuntu-tb710fu/release-prep/sanitize_accounts.py','ubuntu-tb710fu/release-prep/audit-rootfs.py','ubuntu-tb710fu/release-prep/scan_private_markers.py',
 'ubuntu-tb710fu/release-prep/first_user_provision.py','ubuntu-tb710fu/release-prep/first-user-provision.service',
 'ubuntu-tb710fu/offline-prep/power-session/tb-backlight-power-user.py','ubuntu-tb710fu/offline-prep/wowtype-osk/fcitx-session-start.py',
 'ubuntu-tb710fu/offline-prep/osk-backspace-fallback/extension.js','ubuntu-tb710fu/offline-prep/osk-backspace-fallback/metadata.json',
 *['ubuntu-tb710fu/offline-prep/android-window-controls/'+n for n in ('extension.js','navigation.js','metadata.json','stylesheet.css')],
 *['ubuntu-tb710fu/release-prep/generic-user/'+n for n in ('catalog-seed.json','95-tb710fu-playback-clock.conf','droidloom-launch','droidloom-fix-launchers','droidloom-watch-launchers','droidloom-watch-launchers.service')],
 *['ubuntu-tb710fu/release-prep/single-installer/'+n for n in ('tb-install-single.sh','tb-installer.service','merge_accounts.py','validate_preserve_root.py','payload_parts.py','README-DEV.zh-CN.txt','nbdserver/LICENSE','windows/install.cmd','windows/install.ps1','ubuntu/tb710fu-update.sh','ubuntu/tb710fu-update.desktop')],
 'ubuntu-tb710fu/artifacts/kernel-20261118-release/ubuntu-kernel-upgrade-20261118/boot.img',
 'ubuntu-tb710fu/artifacts/ubuntu-release-20261116/prior-install-single.img','ubuntu-tb710fu/artifacts/ubuntu-release-20261116/prior-nbdserver.exe',
 *['ubuntu-tb710fu/sources/TB710FU-Archlinux/build/rom/windows/tools/'+n for n in ('fastboot.exe','AdbWinApi.dll','AdbWinUsbApi.dll','zstd.exe','NOTICE-platform-tools.txt','LICENSE-zstd.txt')],
]
try:
 (contents/'MacOS').mkdir(parents=True); workspace.mkdir(parents=True)
 for rel in inputs:
  src=ROOT/rel
  if not src.is_file() or src.is_symlink(): raise RuntimeError('缺少安全的构建资源：'+rel)
  dst=workspace/rel; dst.parent.mkdir(parents=True,exist_ok=True); shutil.copyfile(src,dst)
 (contents/'Info.plist').write_text('''<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleName</key><string>TB710FU Ubuntu 打包工具</string><key>CFBundleIdentifier</key><string>org.tb710fu.ubuntu-packager</string><key>CFBundleExecutable</key><string>TBPackager</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleShortVersionString</key><string>0.1-preview</string><key>NSHighResolutionCapable</key><true/></dict></plist>''')
 subprocess.run(['xcrun','swiftc','-O',str(BASE/'App.swift'),'-o',str(contents/'MacOS/TBPackager')],check=True)
 subprocess.run(['xattr','-cr',str(app)],check=True)
 subprocess.run(['codesign','--force','--deep','--sign','-',str(app)],check=True)
 subprocess.run(['xattr','-d','com.apple.FinderInfo',str(app)],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
 subprocess.run(['codesign','--verify','--deep','--strict',str(app)],check=True)
 shutil.move(str(app),str(destination))
 print('应用已生成：',destination)
except BaseException:
 if app.exists(): shutil.rmtree(app)
 raise
finally:
 shutil.rmtree(stage,ignore_errors=True)
