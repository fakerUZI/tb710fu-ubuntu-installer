import importlib.util
import shutil
import tempfile
import unittest
from pathlib import Path

HERE=Path(__file__).resolve().parent
PREP=HERE.parent/'release-prep'

class ReleaseAuditTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(); self.root=Path(self.temp.name)/'root'; self.root.mkdir()
        code=Path(self.temp.name)/'audit'; code.mkdir()
        shutil.copyfile(HERE/'audit_release.py',code/'audit-rootfs.py')
        shutil.copyfile(PREP/'audit-rootfs.py',code/'audit-rootfs-base.py')
        spec=importlib.util.spec_from_file_location('release_audit',code/'audit-rootfs.py'); self.audit=importlib.util.module_from_spec(spec); spec.loader.exec_module(self.audit)
        self.write('etc/os-release','ID=ubuntu\n'); self.write('etc/passwd','root:x:0:0:root:/root:/bin/bash\n'); self.write('etc/shadow','root:!:1:0:99999:7:::\n')
        self.write('var/lib/dpkg/status','Package: google-chrome-stable\nStatus: install ok installed\n\nPackage: tb710fu-repair-assistant\nStatus: install ok installed\n')
        self.write('opt/google/chrome/chrome','generic executable')
    def tearDown(self): self.temp.cleanup()
    def write(self,name,text):
        p=self.root/name; p.parent.mkdir(parents=True,exist_ok=True); p.write_text(text)
    def test_allows_only_clean_browser_and_requires_repair_assistant(self):
        self.assertEqual(self.audit.audit(self.root),[])
        self.write('var/lib/dpkg/status','Package: google-chrome-stable\nStatus: install ok installed\n')
        self.assertTrue(any('tb710fu-repair-assistant' in x for x in self.audit.audit(self.root)))
    def test_browser_profile_and_other_personal_state_still_fail(self):
        self.write('opt/google/chrome/User Data/Default/History','private')
        self.write('home/alice/secret','private')
        issues=self.audit.audit(self.root)
        self.assertTrue(any('browser user state' in x for x in issues)); self.assertTrue(any('home contains' in x for x in issues))
    def test_qq_still_rejected(self):
        self.write('opt/QQ/file','private')
        self.assertTrue(any('opt/QQ' in x for x in self.audit.audit(self.root)))

if __name__=='__main__': unittest.main()
