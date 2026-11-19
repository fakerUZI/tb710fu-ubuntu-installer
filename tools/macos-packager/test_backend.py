import importlib.util,json,shutil,subprocess,sys,tempfile,types,unittest,zipfile
from pathlib import Path
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('tbpackager',Path(__file__).with_name('backend.py'))
m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)

class BuilderTests(unittest.TestCase):
    def test_generated_scripts_use_private_unique_paths_and_parse(self):
        base='/root/tb710fu-packager/'+'a'*32; remote='/tmp/tb-packager-'+'a'*32
        scripts=m.make_scripts(base,remote,'')
        for script in scripts:
            p=subprocess.run(['bash','-n'],input=script,text=True,capture_output=True)
            self.assertEqual(p.returncode,0,p.stderr)
            self.assertIn(base,script)
        self.assertIn('--exclude=/home',scripts[0])
        self.assertIn('--exclude=/swapfile',scripts[0])
        self.assertIn('retired-front-camera-20261113',scripts[1])
        self.assertNotIn("--exclude='*gc13a2*'",scripts[1])
        self.assertNotIn('dpkg -i /tmp/tb-repair.deb',scripts[1])
        self.assertNotIn('--exclude=/opt/google ',scripts[1])
        self.assertNotIn('workbuddy google-chrome-stable flclash',scripts[1])
        self.assertIn('--exclude=/etc/opt/chrome',scripts[0])
        self.assertIn('--exclude=/etc/opt/chrome',scripts[1])
        self.assertIn('/usr/local/sbin/tb710fu-update',scripts[1])
        self.assertIn('/usr/share/applications/tb710fu-update.desktop',scripts[1])
        self.assertIn('result_dir=/var/tmp/tb-packager-'+'a'*32,scripts[3])
        self.assertIn('"$result_dir/payload.img.zst"',scripts[3])
        self.assertNotIn('"$inputs/payload.img.zst"',scripts[3])
        self.assertIn('$m/usr/share/tb710fu-repair-assistant/catalog-seed.json',scripts[2])
    def test_rejects_unsafe_stage_path(self):
        with self.assertRaises(ValueError): m.make_scripts('/root/elsewhere','/tmp/foo','')
    def test_changed_template_fails_closed(self):
        with self.assertRaises(RuntimeError): m.patch_once('abc','missing','new')
    def test_power_and_boot_are_checked_before_packaging(self):
        self.assertEqual(m.digest(m.BOOT),m.BOOT_HASH)
        self.assertEqual(m.digest(Path(__file__).with_name('tb-power-key-reviewed.py')),m.POWER_HASH)
    def test_root_helpers_do_not_leave_root_owned_bytecode(self):
        with tempfile.TemporaryDirectory() as td:
            folder=Path(td); m.prepare_inputs(folder,'/root/tb710fu-packager/'+'a'*32,'/tmp/tb-packager-'+'a'*32)
            self.assertIn('export PYTHONDONTWRITEBYTECODE=1',(folder/'run.sh').read_text())
    def test_assemble_writes_only_expected_manifest_and_payload(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d)/'root'; root.mkdir(); out=Path(d)/'out'; out.mkdir()
            one=root/'one'; one.write_bytes(b'generic installer')
            single=root/'single'; (single/'windows').mkdir(parents=True)
            (single/'nbdserver').mkdir(); (single/'nbdserver/LICENSE').write_text('license')
            (single/'README-DEV.zh-CN.txt').write_text('公开镜像不包含 QQ、WorkBuddy、FlClash 或 Google Chrome；提供 GNOME Web 浏览器，其他应用由使用者自行获取。')
            (single/'windows/install.cmd').write_text('run')
            (single/'windows/install.ps1').write_text('hash='+m.OLD_HASH)
            tools=root/'ubuntu-tb710fu/sources/TB710FU-Archlinux/build/rom/windows/tools'; tools.mkdir(parents=True)
            for n in ('fastboot.exe','AdbWinApi.dll','AdbWinUsbApi.dll','zstd.exe','NOTICE-platform-tools.txt','LICENSE-zstd.txt'): (tools/n).write_bytes(b'test')
            art=root/'artifacts'; (art/'ubuntu-release-20261116').mkdir(parents=True)
            for n in ('prior-install-single.img','prior-nbdserver.exe'): (art/'ubuntu-release-20261116'/n).write_bytes(b'generic')
            payload=root/'payload'; payload.write_bytes(b'clean payload')
            mod=types.ModuleType('payload_parts')
            def split(p,folder):
                data=p.read_bytes(); (folder/'payload-001.part').write_bytes(data); h=__import__('hashlib').sha256(data).hexdigest(); return h,[{'size':len(data),'sha256':h,'url':''}]
            mod.split_payload=split
            with patch.multiple(m,ROOT=root,SINGLE=single,ART=art,BOOT=one), patch.dict(sys.modules,{'payload_parts':mod}): result=m.assemble(payload,out)
            with zipfile.ZipFile(result) as z:
                self.assertIsNone(z.testzip())
                names=z.namelist(); self.assertTrue(any(n.endswith('rootfs/parts/payload-001.part') for n in names))
                entry=next(n for n in names if n.endswith('windows/install.ps1')); self.assertIn(m.BOOT_HASH,z.read(entry).decode())
                entry=next(n for n in names if n.endswith('manifest.json')); manifest=json.loads(z.read(entry)); self.assertEqual(len(manifest['payload']['parts']),1)
                entry=next(n for n in names if n.endswith('README.zh-CN.txt')); self.assertIn('镜像保留修复助手和 Google Chrome',z.read(entry).decode())
            self.assertTrue(result.with_suffix('.zip.sha256').is_file())

if __name__=='__main__': unittest.main()
