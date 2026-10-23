"""scripts/vm-grant-base.sh finish, and its header's steps for the QQ base: a base with QQ is finished by
scripts/vm-qq-base.sh finish (it quits QQ and waits before the shutdown, which keeps the test account's login), so
this script's finish refuses it before changing anything; cu-base is self-checked, cleaned and shut down as before.

No VM is used. The scripts are copied into a temp root, VMDIR is a temp dir with a fake tart, and sshpass on PATH is a
fake that logs the command each ssh would run in the guest and answers the two questions finish asks (is QQ there,
the self-check's JSON). python3 and grep are the real ones.
"""
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]

FAKE_TART = r'''#!/bin/sh
echo "tart $*" >> "$FAKE_LOG"
case "$1" in
  ip) echo 192.0.2.10 ;;
  list) printf 'local  cu-base     50 20 0 stopped\nlocal  cu-base-qq  50 20 0 stopped\n' ;;
  *) exit 90 ;;
esac
'''
# sshpass -e ssh <options> a1@IP "<command>": the command is the last argument.
FAKE_SSHPASS = r'''#!/bin/sh
for last in "$@"; do :; done
echo "guest $last" >> "$FAKE_LOG"
case "$last" in
  *Applications/QQ.app*) if [ -n "$FAKE_QQ" ]; then echo has-qq; else echo no-qq; fi ;;
  *self-check*) echo '{"ax_trusted": true, "sck": {"ok": true}}' ;;
esac
exit 0
'''


class VmGrantBaseFinishTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, self.tmp)
        (self.tmp / 'root/scripts').mkdir(parents=True)
        for name in ('vm-grant-base.sh', 'vm-lib.sh'):
            shutil.copyfile(REPO / 'scripts' / name, self.tmp / 'root/scripts' / name)
        tart = self.tmp / 'vm/tart.app/Contents/MacOS/tart'
        tart.parent.mkdir(parents=True)
        tart.write_text(FAKE_TART)
        tart.chmod(0o755)
        bin_dir = self.tmp / 'bin'
        bin_dir.mkdir()
        (bin_dir / 'sshpass').write_text(FAKE_SSHPASS)
        (bin_dir / 'sshpass').chmod(0o755)
        for real in (sys.executable, '/usr/bin/grep'):
            (bin_dir / ('python3' if real == sys.executable else Path(real).name)).symlink_to(real)
        (self.tmp / 'home').mkdir()
        self.log = self.tmp / 'fake.log'
        self.env = {'PATH': f'{bin_dir}:/bin', 'HOME': str(self.tmp / 'home'), 'VMDIR': str(self.tmp / 'vm'),
                    'CU_GUEST_PASS': 'not-a-real-password', 'FAKE_LOG': str(self.log)}

    def finish(self, **env):
        p = subprocess.run(['/bin/zsh', '-f', str(self.tmp / 'root/scripts/vm-grant-base.sh'), 'finish'],
                           env={**self.env, **env}, capture_output=True, text=True, timeout=60)
        guest = [line[len('guest '):] for line in self.log.read_text().splitlines() if line.startswith('guest ')] \
            if self.log.exists() else []
        self.log.unlink(missing_ok=True)
        return p.returncode, p.stdout, p.stderr, guest

    def test_a_base_with_qq_is_refused_before_anything_changes(self):
        rc, out, err, guest = self.finish(CU_BASE='cu-base-qq', FAKE_QQ='1')
        self.assertEqual(rc, 1, err)
        self.assertIn('cu-base-qq has QQ: finish it with CU_BASE=cu-base-qq scripts/vm-qq-base.sh finish', out)
        self.assertIn('Nothing changed; the base is still running at 192.0.2.10', out)
        self.assertEqual(len(guest), 1, guest)   # the question, nothing else
        self.assertIn('Applications/QQ.app', guest[0])
        self.assertIn('pgrep -x QQ', guest[0])

    def test_cu_base_is_checked_cleaned_and_shut_down(self):
        rc, out, err, guest = self.finish()
        self.assertEqual(rc, 0, err)
        self.assertIn('cu-base stopped', out)
        self.assertEqual(len(guest), 4, guest)
        self.assertIn('Applications/QQ.app', guest[0])
        self.assertIn('self-check', guest[1])
        self.assertIn('pkill -x cu-runtime', guest[2])
        self.assertIn('shutdown -h now', guest[3])


class GrantStepsTest(unittest.TestCase):
    def test_step_6_finishes_the_qq_base_with_vm_qq_base(self):
        header = (REPO / 'scripts/vm-grant-base.sh').read_text().split('set -euo pipefail', 1)[0]
        step6 = header.split('#   6. ', 1)[1]
        self.assertIn('CU_BASE=cu-base-qq scripts/vm-grant-base.sh prepare', step6)
        self.assertIn('then scripts/vm-qq-base.sh finish (not this script\'s finish)', step6)
        self.assertNotIn('steps 3 and 4', header)
        # Step 5 builds again: the keychain asks once more.
        step5 = header.split('#   5. ', 1)[1].split('#   6. ', 1)[0]
        self.assertIn('Allow, not Always Allow', step5)

    def test_the_bench_readme_says_the_same(self):
        text = (REPO / 'bench/README.md').read_text()
        line = [line for line in text.splitlines() if 'cu-runtime-bench-signing' in line and 'vm-grant-base.sh' in line]
        self.assertEqual(len(line), 1, line)
        self.assertIn('`CU_BASE=cu-base-qq scripts/vm-grant-base.sh prepare`', line[0])
        self.assertIn('`scripts/vm-qq-base.sh finish`', line[0])
        self.assertNotIn('QQ 底板同样要做一次（`CU_BASE=cu-base-qq`）', line[0])


if __name__ == '__main__':
    unittest.main()
